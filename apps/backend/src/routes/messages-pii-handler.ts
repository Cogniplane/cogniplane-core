import type { AuditEventStore } from "../services/audit-event-store.js";
import type { PiiDecision } from "../services/pii/pii-protection-service.js";
import type { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";

export type PiiHandlerInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  rawText: string;
};

export type PiiHandlerStores = {
  piiScanRuns: PiiScanRunStore | undefined;
  auditEvents?: AuditEventStore;
};

export type PiiHandlerOutcome =
  | { kind: "block"; scanRunId: string | null; blockReason: string }
  | {
      kind: "continue";
      persistedText: string;
      runtimePrompt: string;
      userDetail: { pii?: Record<string, unknown> } | undefined;
      transformScanRunId: string | undefined;
    };

// Centralizes the three non-allow PII actions (block / transform / report)
// so each one persists a scan run and composes a user-message `detail`
// payload through a single path. The block action terminates the request —
// the route still owns the SSE response, but the scan-run write and block
// metadata come from here.
export async function handlePiiDecision(
  decision: PiiDecision | null,
  input: PiiHandlerInput,
  stores: PiiHandlerStores
): Promise<PiiHandlerOutcome> {
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
      actionTaken: "block"
    });
    await emitPiiAudit(stores, input, "pii_blocked", {
      scanRunId: scanRun?.scanRunId ?? null,
      mode: "block",
      subjectType: "message",
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      blockReason: decision.blockReason
    });
    return {
      kind: "block",
      scanRunId: scanRun?.scanRunId ?? null,
      blockReason: decision.blockReason
    };
  }

  if (decision.action === "transform") {
    const scanRun = await createScanRun(stores, input, decision, {
      mode: "transform",
      status: "transformed",
      actionTaken: "transform"
    });
    await emitPiiAudit(stores, input, "pii_transformed", {
      scanRunId: scanRun?.scanRunId ?? null,
      mode: "transform",
      subjectType: "message",
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
          transformed: true,
          ...(scanRun ? { scanRunId: scanRun.scanRunId } : {}),
          findingsCount: decision.findings.length
        }
      },
      transformScanRunId: scanRun?.scanRunId
    };
  }

  // decision.action === "report"
  const scanRun = await createScanRun(stores, input, decision, {
    mode: "detect",
    status: "completed",
    actionTaken: "report"
  });
  await emitPiiAudit(stores, input, "pii_reported", {
    scanRunId: scanRun?.scanRunId ?? null,
    mode: "detect",
    subjectType: "message",
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
  eventType: "pii_blocked" | "pii_transformed" | "pii_reported",
  payload: Record<string, unknown>
): Promise<void> {
  if (!stores.auditEvents) return;
  await stores.auditEvents.create({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    type: eventType,
    payload
  });
}

type ScanRunMeta = {
  mode: "block" | "transform" | "detect";
  status: "blocked" | "transformed" | "completed";
  actionTaken: "block" | "transform" | "report";
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
    subjectType: "message",
    subjectId: input.sessionId,
    sourceSessionId: input.sessionId,
    sourceUserId: input.userId,
    mode: meta.mode,
    providerType: decision.providerType,
    providerModel: decision.providerModel,
    status: meta.status,
    findings: decision.findings,
    actionTaken: meta.actionTaken
  });
}
