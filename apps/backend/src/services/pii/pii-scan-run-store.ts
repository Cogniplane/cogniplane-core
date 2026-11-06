
import { z } from "zod";
import { PiiEntityTypeSchema, PiiModeSchema } from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../../lib/db.js";
import type { PiiFinding } from "./pii-provider.js";
import { uuidv7 } from "../../lib/uuid.js";
import { isoTimestamp } from "../../lib/db-mappers.js";

export type PiiScanSubjectType = "message" | "artifact";
export type PiiScanRunSubjectType = PiiScanSubjectType | "project_instructions";

export type PiiScanMode = "off" | "detect" | "block" | "transform";

export const PII_SCAN_ACTION_TAKEN = ["allow", "report", "block", "transform"] as const;
export type PiiScanActionTaken = (typeof PII_SCAN_ACTION_TAKEN)[number];

export type PiiScanStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "blocked"
  | "transformed";

export type PiiScanRunRecord = {
  tenantId: string;
  scanRunId: string;
  subjectType: PiiScanRunSubjectType;
  instructionsRevision?: number | null;
  subjectId: string;
  sourceSessionId: string | null;
  sourceUserId: string | null;
  /**
   * The scan mode. A queued scan sets it to the mode that it applied when it
   * ran; `pii_scan_jobs.mode` keeps the mode at enqueue time.
   */
  mode: PiiScanMode;
  /** The PII settings revision that the scan read. Null when the scan did not record it. */
  policyRevision: number | null;
  providerType: string | null;
  providerModel: string | null;
  status: PiiScanStatus;
  findings: PiiFinding[];
  summaryText: string | null;
  actionTaken: PiiScanActionTaken | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreatePiiScanRunInput = {
  tenantId: string;
  scanRunId?: string;
  subjectType: PiiScanRunSubjectType;
  instructionsRevision?: number | null;
  subjectId: string;
  sourceSessionId?: string | null;
  sourceUserId?: string | null;
  mode: PiiScanMode;
  /** The PII settings revision that a synchronous scan read. A queued scan sets it when it runs. */
  policyRevision?: number | null;
  providerType?: string | null;
  providerModel?: string | null;
  status?: PiiScanStatus;
  findings?: PiiFinding[];
  summaryText?: string | null;
  actionTaken?: PiiScanActionTaken | null;
  errorMessage?: string | null;
};

/**
 * The decision that a queued scan made, recorded before the scan applies it
 * (`pending_decision`). A later attempt finishes this decision and does not
 * evaluate the subject again. See `PiiScanJobHandler`.
 */
export type PiiScanRunDecision = {
  action: PiiScanActionTaken;
  /** The mode that the evaluation applied. `off` when it scanned nothing. */
  mode: PiiScanMode;
  /** The PII settings revision that the evaluation read. */
  policyRevision: number;
  findings: PiiFinding[];
  providerType: string | null;
  providerModel: string | null;
  /** Set for a block. */
  blockReason?: string;
  /** The scan read only the text of the file; images in it were not scanned. */
  imagesNotScanned?: boolean;
};

const PendingDecisionSchema = z.object({
  action: z.enum(PII_SCAN_ACTION_TAKEN),
  mode: PiiModeSchema,
  policyRevision: z.number().int().nonnegative(),
  findings: z.array(z.object({
    entityType: PiiEntityTypeSchema,
    value: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    confidence: z.enum(["low", "medium", "high"])
  }).refine((finding) => finding.end >= finding.start)),
  providerType: z.string().nullable(),
  providerModel: z.string().nullable(),
  blockReason: z.string().optional(),
  imagesNotScanned: z.boolean().optional()
});

function parseDecision(raw: unknown): PiiScanRunDecision | null {
  if (raw === null || raw === undefined) return null;
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  return PendingDecisionSchema.parse(value);
}

export type UpdatePiiScanRunInput = {
  status?: PiiScanStatus;
  mode?: PiiScanMode;
  policyRevision?: number | null;
  providerType?: string | null;
  providerModel?: string | null;
  findings?: PiiFinding[];
  summaryText?: string | null;
  actionTaken?: PiiScanActionTaken | null;
  errorMessage?: string | null;
  completedAt?: Date | null;
  /** `null` clears the recorded decision, as the terminal update of a queued scan does. */
  pendingDecision?: null;
};

function mapRow(row: Record<string, unknown>): PiiScanRunRecord {
  const findingsRaw = row.findings_json;
  let findings: PiiFinding[] = [];
  if (Array.isArray(findingsRaw)) {
    findings = findingsRaw as PiiFinding[];
  } else if (typeof findingsRaw === "string") {
    try {
      const parsed = JSON.parse(findingsRaw);
      if (Array.isArray(parsed)) {
        findings = parsed as PiiFinding[];
      }
    } catch {
      findings = [];
    }
  }

  return {
    tenantId: String(row.tenant_id),
    scanRunId: String(row.scan_run_id),
    subjectType: row.subject_type === "project_instructions" ? "project_instructions"
      : row.subject_type === "artifact" ? "artifact" : "message",
    instructionsRevision: row.instructions_revision == null ? null : Number(row.instructions_revision),
    subjectId: String(row.subject_id),
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    sourceUserId: row.source_user_id == null ? null : String(row.source_user_id),
    mode: row.mode as PiiScanMode,
    policyRevision: row.policy_revision == null ? null : Number(row.policy_revision),
    providerType: row.provider_type == null ? null : String(row.provider_type),
    providerModel: row.provider_model == null ? null : String(row.provider_model),
    status: row.status as PiiScanStatus,
    findings,
    summaryText: row.summary_text == null ? null : String(row.summary_text),
    actionTaken: row.action_taken == null ? null : (String(row.action_taken) as PiiScanActionTaken),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    completedAt:
      row.completed_at == null ? null : isoTimestamp(row.completed_at)
  };
}

export class PiiScanRunStore {
  constructor(private readonly db: Pool) {}

  async create(input: CreatePiiScanRunInput): Promise<PiiScanRunRecord> {
    const scanRunId = input.scanRunId ?? uuidv7();
    const findings = input.findings ?? [];
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO pii_scan_runs (
            tenant_id,
            scan_run_id,
            subject_type,
            instructions_revision,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            policy_revision,
            provider_type,
            provider_model,
            status,
            findings_json,
            summary_text,
            action_taken,
            error_message
          )
          VALUES ($1, $2, $3, $15, $4, $5, $6, $7, $16, $8, $9, $10, $11::jsonb, $12, $13, $14)
          RETURNING
            tenant_id,
            scan_run_id,
            subject_type,
            instructions_revision,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            policy_revision,
            provider_type,
            provider_model,
            status,
            findings_json,
            summary_text,
            action_taken,
            error_message,
            created_at,
            updated_at,
            completed_at
        `,
        [
          input.tenantId,
          scanRunId,
          input.subjectType,
          input.subjectId,
          input.sourceSessionId ?? null,
          input.sourceUserId ?? null,
          input.mode,
          input.providerType ?? null,
          input.providerModel ?? null,
          input.status ?? "pending",
          JSON.stringify(findings),
          input.summaryText ?? null,
          input.actionTaken ?? null,
          input.errorMessage ?? null,
          input.instructionsRevision ?? null,
          input.policyRevision ?? null
        ]
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async update(
    tenantId: string,
    scanRunId: string,
    patch: UpdatePiiScanRunInput
  ): Promise<PiiScanRunRecord | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    const push = (fragment: string, value: unknown) => {
      setClauses.push(fragment.replace("$$", `$${index}`));
      values.push(value);
      index += 1;
    };

    if (patch.status !== undefined) push("status = $$", patch.status);
    if (patch.mode !== undefined) push("mode = $$", patch.mode);
    if (patch.policyRevision !== undefined) push("policy_revision = $$", patch.policyRevision);
    if (patch.providerType !== undefined) push("provider_type = $$", patch.providerType);
    if (patch.providerModel !== undefined) push("provider_model = $$", patch.providerModel);
    if (patch.findings !== undefined) push("findings_json = $$::jsonb", JSON.stringify(patch.findings));
    if (patch.summaryText !== undefined) push("summary_text = $$", patch.summaryText);
    if (patch.actionTaken !== undefined) push("action_taken = $$", patch.actionTaken);
    if (patch.errorMessage !== undefined) push("error_message = $$", patch.errorMessage);
    if (patch.completedAt !== undefined) {
      push("completed_at = $$", patch.completedAt);
    }
    if (patch.pendingDecision !== undefined) push("pending_decision = $$", patch.pendingDecision);

    setClauses.push("updated_at = NOW()");

    const tenantPlaceholder = `$${index}`;
    values.push(tenantId);
    index += 1;
    const runPlaceholder = `$${index}`;
    values.push(scanRunId);

    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE pii_scan_runs
          SET ${setClauses.join(", ")}
          WHERE tenant_id = ${tenantPlaceholder} AND scan_run_id = ${runPlaceholder}
            ${patch.status === "processing" ? "AND status IN ('pending', 'processing')" : ""}
          RETURNING
            tenant_id,
            scan_run_id,
            subject_type,
            instructions_revision,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            policy_revision,
            provider_type,
            provider_model,
            status,
            findings_json,
            summary_text,
            action_taken,
            error_message,
            created_at,
            updated_at,
            completed_at
        `,
        values
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Records the decision of a queued scan before the scan applies it. Only
   * the first decision is kept, and only while the scan run is open. Returns
   * false when the run already has a decision or is closed: the caller must
   * then read the recorded decision (`getPendingDecision`) and must not apply
   * its own.
   */
  async recordDecision(
    tenantId: string,
    scanRunId: string,
    decision: PiiScanRunDecision
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE pii_scan_runs
          SET pending_decision = $3::jsonb, updated_at = NOW()
          WHERE tenant_id = $1 AND scan_run_id = $2
            AND status IN ('pending', 'processing')
            AND pending_decision IS NULL
        `,
        [tenantId, scanRunId, JSON.stringify(decision)]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Lock before deciding whether recovery can write failure. A decision
   * writer waits for this transaction, so it cannot record a block between
   * the check and the subject write. Closed runs are left intact.
   * The subject write must finish before the run closes. If it fails, the
   * transaction rolls back and recovery can try again.
   */
  async finishUndecidedFailure(
    tenantId: string,
    scanRunId: string,
    errorMessage: string,
    writeSubject: () => Promise<void>
  ): Promise<PiiScanRunDecision | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT status, pending_decision FROM pii_scan_runs
         WHERE tenant_id = $1 AND scan_run_id = $2 FOR UPDATE`,
        [tenantId, scanRunId]
      );
      const row = result.rows[0];
      if (!row || !["pending", "processing"].includes(row.status)) return null;
      const decision = parseDecision(row.pending_decision);
      if (decision) return decision;
      await writeSubject();
      await client.query(
        `UPDATE pii_scan_runs
         SET status = 'failed', error_message = $3, completed_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND scan_run_id = $2`,
        [tenantId, scanRunId, errorMessage]
      );
      return null;
    });
  }

  /** The decision that an open scan run recorded and did not finish. */
  async getPendingDecision(tenantId: string, scanRunId: string): Promise<PiiScanRunDecision | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT pending_decision
          FROM pii_scan_runs
          WHERE tenant_id = $1 AND scan_run_id = $2
            AND status IN ('pending', 'processing')
        `,
        [tenantId, scanRunId]
      );
      return parseDecision(result.rows[0]?.pending_decision);
    });
  }

  async getById(tenantId: string, scanRunId: string): Promise<PiiScanRunRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            tenant_id,
            scan_run_id,
            subject_type,
            instructions_revision,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            policy_revision,
            provider_type,
            provider_model,
            status,
            findings_json,
            summary_text,
            action_taken,
            error_message,
            created_at,
            updated_at,
            completed_at
          FROM pii_scan_runs
          WHERE tenant_id = $1 AND scan_run_id = $2
          LIMIT 1
        `,
        [tenantId, scanRunId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }
}
