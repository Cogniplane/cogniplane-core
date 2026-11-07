import type { AuditEventStore } from "../audit-event-store.js";
import {
  PiiProtectionServiceError,
  type PiiDecision,
  type PiiEvaluation,
  type PiiProtectionService
} from "./pii-protection-service.js";
import { PII_POLICY_INVALID_CODE } from "./pii-policy.js";
import { PERMANENT_PII_ERROR_CODES } from "./pii-scan-job-handler.js";
import type { PiiScanRunStore } from "./pii-scan-run-store.js";

export type PiiHandlerInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  rawText: string;
  projectInstructions?: { projectId: string; revision: number };
};

export type PiiHandlerStores = {
  piiScanRuns:
    | {
        create(
          input: Parameters<PiiScanRunStore["create"]>[0]
        ): Promise<{ scanRunId: string }>;
      }
    | undefined;
  auditEvents?: Pick<AuditEventStore, "create">;
  logger?: { warn(payload: unknown, message: string): void };
};

export type PiiHandlerOutcome =
  // `policyRevision` is the PII settings revision that the decision read.
  | { kind: "block"; scanRunId: string | null; blockReason: string; policyRevision?: number }
  | {
      kind: "continue";
      persistedText: string;
      runtimePrompt: string;
      userDetail: { pii?: Record<string, unknown> } | undefined;
      transformScanRunId: string | undefined;
    };

export type ChatPromptGateStores = PiiHandlerStores & {
  // Absent when PII protection is not configured for this deployment.
  piiProtection: Pick<PiiProtectionService, "evaluateTextWithPolicy"> | undefined;
};

export type ChatPromptGateResult =
  // Fail closed: the prompt must not be saved or sent. `permanent` errors
  // will fail again on retry; the others are provider outages.
  | { kind: "unavailable"; error: PiiProtectionServiceError; permanent: boolean }
  | Extract<PiiHandlerOutcome, { kind: "block" }>
  | (Extract<PiiHandlerOutcome, { kind: "continue" }> & { decision: PiiDecision | null });

/**
 * Apply the tenant's current chat-prompt policy to text that will reach the
 * model. Interactive messages, project instructions, and scheduled jobs all
 * use it, so block, transform, scan runs, and audit stay the same.
 */
export async function gateChatPrompt(
  stores: ChatPromptGateStores,
  input: PiiHandlerInput
): Promise<ChatPromptGateResult> {
  let evaluation: PiiEvaluation | null = null;
  if (stores.piiProtection) {
    try {
      evaluation = await stores.piiProtection.evaluateTextWithPolicy({
        tenantId: input.tenantId,
        text: input.rawText,
        subject: { kind: "chat_prompt" }
      });
    } catch (error) {
      if (!(error instanceof PiiProtectionServiceError)) throw error;
      if (error.code === PII_POLICY_INVALID_CODE) {
        await emitPiiAudit(stores, input, "pii_policy_invalid", {
          subjectType: input.projectInstructions ? "project_instructions" : "message",
          ...(error.policyRevision !== undefined ? { policyRevision: error.policyRevision } : {})
        });
      }
      return { kind: "unavailable", error, permanent: PERMANENT_PII_ERROR_CODES.has(error.code) };
    }
  }
  const decision = evaluation?.decision ?? null;
  const outcome = await handlePiiDecision(decision, input, stores, evaluation?.appliedPolicy.revision);
  return outcome.kind === "block" ? outcome : { ...outcome, decision };
}

// Centralizes the three non-allow PII actions (block / transform / report)
// so each one persists a scan run and composes a user-message `detail`
// payload through a single path. The block action terminates the request —
// the route still owns the SSE response, but the scan-run write and block
// metadata come from here. `policyRevision` is the PII settings revision that
// the decision read; the scan run, the detail, and the audit event record it.
export async function handlePiiDecision(
  decision: PiiDecision | null,
  input: PiiHandlerInput,
  stores: PiiHandlerStores,
  policyRevision?: number
): Promise<PiiHandlerOutcome> {
  const revision = policyRevision !== undefined ? { policyRevision } : {};
  if (!decision || decision.action === "allow") {
    return {
      kind: "continue",
      persistedText: input.rawText,
      runtimePrompt: input.rawText,
      userDetail: undefined,
      transformScanRunId: undefined
    };
  }

  if (decision.action === "block") {
    const scanRun = await createScanRun(stores, input, decision, {
      mode: "block",
      status: "blocked",
      actionTaken: "block",
      ...revision
    });
    await emitPiiAudit(stores, input, "pii_blocked", {
      scanRunId: scanRun?.scanRunId ?? null,
      mode: "block",
      ...revision,
      subjectType: input.projectInstructions ? "project_instructions" : "message",
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      blockReason: decision.blockReason
    });
    return {
      kind: "block",
      scanRunId: scanRun?.scanRunId ?? null,
      blockReason: decision.blockReason,
      ...revision
    };
  }

  if (decision.action === "transform") {
    const scanRun = await createScanRun(stores, input, decision, {
      mode: "transform",
      status: "transformed",
      actionTaken: "transform",
      ...revision
    });
    await emitPiiAudit(stores, input, "pii_transformed", {
      scanRunId: scanRun?.scanRunId ?? null,
      mode: "transform",
      ...revision,
      subjectType: input.projectInstructions ? "project_instructions" : "message",
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel
    });
    return {
      kind: "continue",
      persistedText: decision.transformedText,
      runtimePrompt: decision.transformedText,
      userDetail: {
        pii: {
          status: "transformed",
          modeApplied: "transform",
          ...revision,
          transformed: true,
          ...(scanRun ? { scanRunId: scanRun.scanRunId } : {}),
          findingsCount: decision.findings.length
        }
      },
      transformScanRunId: scanRun?.scanRunId
    };
  }

  const scanRun = await createScanRun(stores, input, decision, {
    mode: "detect",
    status: "completed",
    actionTaken: "report",
    ...revision
  });
  await emitPiiAudit(stores, input, "pii_reported", {
    scanRunId: scanRun?.scanRunId ?? null,
    mode: "detect",
    ...revision,
    subjectType: input.projectInstructions ? "project_instructions" : "message",
    findingsCount: decision.findings.length,
    providerType: decision.providerType,
    providerModel: decision.providerModel
  });
  return {
    kind: "continue",
    persistedText: input.rawText,
    runtimePrompt: input.rawText,
    userDetail: {
      pii: {
        status: "detected",
        modeApplied: "detect",
        ...revision,
        ...(scanRun ? { scanRunId: scanRun.scanRunId } : {}),
        findingsCount: decision.findings.length
      }
    },
    transformScanRunId: undefined
  };
}

async function emitPiiAudit(
  stores: PiiHandlerStores,
  input: PiiHandlerInput,
  eventType: "pii_blocked" | "pii_transformed" | "pii_reported" | "pii_policy_invalid",
  payload: Record<string, unknown>
): Promise<void> {
  if (!stores.auditEvents) return;
  try {
    await stores.auditEvents.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      type: eventType,
      payload: { ...payload, ...(input.projectInstructions ? {
        projectId: input.projectInstructions.projectId,
        instructionsRevision: input.projectInstructions.revision
      } : {}) }
    });
  } catch (err) {
    stores.logger?.warn({ err, eventType, sessionId: input.sessionId }, "Failed to record PII audit event");
  }
}

type ScanRunMeta = {
  mode: "block" | "transform" | "detect";
  status: "blocked" | "transformed" | "completed";
  actionTaken: "block" | "transform" | "report";
  policyRevision?: number;
};

async function createScanRun(
  stores: PiiHandlerStores,
  input: PiiHandlerInput,
  decision: Exclude<PiiDecision, { action: "allow" }>,
  meta: ScanRunMeta
): Promise<{ scanRunId: string } | null> {
  if (!stores.piiScanRuns) return null;
  return stores.piiScanRuns.create({
    tenantId: input.tenantId,
    subjectType: input.projectInstructions ? "project_instructions" : "message",
    subjectId: input.projectInstructions?.projectId ?? input.sessionId,
    ...(input.projectInstructions ? { instructionsRevision: input.projectInstructions.revision } : {}),
    sourceSessionId: input.sessionId,
    sourceUserId: input.userId,
    mode: meta.mode,
    ...(meta.policyRevision !== undefined ? { policyRevision: meta.policyRevision } : {}),
    providerType: decision.providerType,
    providerModel: decision.providerModel,
    status: meta.status,
    findings: decision.findings,
    actionTaken: meta.actionTaken
  });
}
