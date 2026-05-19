
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { PiiFinding } from "./pii-provider.js";
import { uuidv7 } from "../../lib/uuid.js";

export type PiiScanSubjectType = "message" | "artifact";

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
  subjectType: PiiScanSubjectType;
  subjectId: string;
  sourceSessionId: string | null;
  sourceUserId: string | null;
  mode: PiiScanMode;
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
  subjectType: PiiScanSubjectType;
  subjectId: string;
  sourceSessionId?: string | null;
  sourceUserId?: string | null;
  mode: PiiScanMode;
  providerType?: string | null;
  providerModel?: string | null;
  status?: PiiScanStatus;
  findings?: PiiFinding[];
  summaryText?: string | null;
  actionTaken?: PiiScanActionTaken | null;
  errorMessage?: string | null;
};

export type UpdatePiiScanRunInput = {
  status?: PiiScanStatus;
  providerType?: string | null;
  providerModel?: string | null;
  findings?: PiiFinding[];
  summaryText?: string | null;
  actionTaken?: PiiScanActionTaken | null;
  errorMessage?: string | null;
  completedAt?: Date | null;
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
    subjectType: row.subject_type === "artifact" ? "artifact" : "message",
    subjectId: String(row.subject_id),
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    sourceUserId: row.source_user_id == null ? null : String(row.source_user_id),
    mode: row.mode as PiiScanMode,
    providerType: row.provider_type == null ? null : String(row.provider_type),
    providerModel: row.provider_model == null ? null : String(row.provider_model),
    status: row.status as PiiScanStatus,
    findings,
    summaryText: row.summary_text == null ? null : String(row.summary_text),
    actionTaken: row.action_taken == null ? null : (String(row.action_taken) as PiiScanActionTaken),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    completedAt:
      row.completed_at == null ? null : new Date(String(row.completed_at)).toISOString()
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
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            provider_type,
            provider_model,
            status,
            findings_json,
            summary_text,
            action_taken,
            error_message
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
          RETURNING
            tenant_id,
            scan_run_id,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
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
          input.errorMessage ?? null
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
    if (patch.providerType !== undefined) push("provider_type = $$", patch.providerType);
    if (patch.providerModel !== undefined) push("provider_model = $$", patch.providerModel);
    if (patch.findings !== undefined) push("findings_json = $$::jsonb", JSON.stringify(patch.findings));
    if (patch.summaryText !== undefined) push("summary_text = $$", patch.summaryText);
    if (patch.actionTaken !== undefined) push("action_taken = $$", patch.actionTaken);
    if (patch.errorMessage !== undefined) push("error_message = $$", patch.errorMessage);
    if (patch.completedAt !== undefined) {
      push("completed_at = $$", patch.completedAt);
    }

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
          RETURNING
            tenant_id,
            scan_run_id,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
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

  async getById(tenantId: string, scanRunId: string): Promise<PiiScanRunRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            tenant_id,
            scan_run_id,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
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

  async listForSubject(
    tenantId: string,
    subjectType: PiiScanSubjectType,
    subjectId: string,
    limit = 50
  ): Promise<PiiScanRunRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            tenant_id,
            scan_run_id,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
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
          WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
          ORDER BY created_at DESC
          LIMIT $4
        `,
        [tenantId, subjectType, subjectId, limit]
      );
      return result.rows.map((row) => mapRow(row as Record<string, unknown>));
    });
  }
}
