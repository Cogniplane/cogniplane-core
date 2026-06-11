import type {
  AdminMcpServerRecord,
  AdminSkillRecord,
  AdminSkillRevisionRecord,
  ApprovalPolicy,
  ApprovalReviewer,
  TenantMemberRecord
} from "./admin-config-records.js";
import { isoTimestamp, isoTimestampOrNull } from "../lib/db-mappers.js";

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
      )
    : [];
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === "never" || value === "on-request") return value;
  // Stored as JSON string for granular mode
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null && "granular" in parsed) {
        return parsed as ApprovalPolicy;
      }
    } catch {
      // fall through
    }
  }
  return "never";
}

export function parseApprovalReviewer(value: unknown): ApprovalReviewer {
  return value === "guardian_subagent" ? "guardian_subagent" : "user";
}

function assertEnum<T extends string>(value: unknown, allowed: T[], label: string): T {
  const str = String(value);
  if (allowed.includes(str as T)) {
    return str as T;
  }
  throw new Error(`Unknown ${label}: ${str}`);
}

export function mapSkill(row: Record<string, unknown>, requestTenantId?: string): AdminSkillRecord {
  const ownerTenantId = row.tenant_id ? String(row.tenant_id) : null;
  return {
    skillId: String(row.skill_id),
    skillName: String(row.skill_name),
    description: row.description ? String(row.description) : null,
    instructions: String(row.instructions),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    enabled: Boolean(row.enabled),
    isPublished: Boolean(row.is_published),
    createdBy: String(row.created_by),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    activeRevisionId: row.active_revision_id ? Number(row.active_revision_id) : null,
    activeSourceType: toNullableString(row.active_source_type),
    activeBundleName: toNullableString(row.active_bundle_name),
    activeBundleStorageUri: toNullableString(row.active_bundle_storage_uri),
    activeBundleHash: toNullableString(row.active_bundle_hash),
    activeValidationStatus: toNullableString(row.active_validation_status),
    activeReviewStatus: toNullableString(row.active_review_status),
    associatedToolIds: toStringArray(row.active_associated_tool_ids),
    isInherited: ownerTenantId === "system" && requestTenantId !== undefined && requestTenantId !== "system"
  };
}

export type SkillActivationMetadata = {
  skillName: string;
  description: string | null;
  instructions: string;
};

/**
 * Extracts the fields required to activate a skill revision from its metadata
 * JSONB. Returns `{ ok: true, value }` when all required fields are present and
 * typed correctly, or `{ ok: false, missing }` listing the offending fields.
 * Activation is the only consumer that requires the full shape — other
 * consumers (e.g. file preview) read different projections defensively.
 */
export function parseSkillActivationMetadata(
  metadata: Record<string, unknown>
): { ok: true; value: SkillActivationMetadata } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const skillName = typeof metadata.skillName === "string" ? metadata.skillName : null;
  const instructions = typeof metadata.instructions === "string" ? metadata.instructions : null;
  if (!skillName) missing.push("skillName");
  if (!instructions) missing.push("instructions");

  if (!skillName || !instructions) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: {
      skillName,
      description: typeof metadata.description === "string" ? metadata.description : null,
      instructions
    }
  };
}

export function mapSkillRevision(row: Record<string, unknown>): AdminSkillRevisionRecord {
  return {
    skillRevisionId: Number(row.skill_revision_id),
    skillId: String(row.skill_id),
    revisionNumber: Number(row.revision_number),
    sourceType: String(row.source_type),
    sourceLabel: toNullableString(row.source_label),
    bundleName: toNullableString(row.bundle_name),
    bundleStorageUri: toNullableString(row.bundle_storage_uri),
    bundleHash: String(row.bundle_hash),
    validationStatus: String(row.validation_status),
    validationMessages: toObjectArray(row.validation_messages),
    reviewStatus: String(row.review_status),
    reviewNotes: toNullableString(row.review_notes),
    metadata: toObjectRecord(row.metadata),
    createdBy: String(row.created_by),
    createdAt: isoTimestamp(row.created_at),
    reviewedBy: toNullableString(row.reviewed_by),
    reviewedAt: isoTimestampOrNull(row.reviewed_at),
    activatedAt: isoTimestampOrNull(row.activated_at)
  };
}

export function mapMcpServer(row: Record<string, unknown>): AdminMcpServerRecord {
  return {
    serverId: String(row.server_id),
    serverName: String(row.server_name),
    description: row.description ? String(row.description) : null,
    transportKind: "http",
    mode: assertEnum(row.mode, ["managed", "proxy"], "MCP server mode"),
    routePath: String(row.route_path),
    upstreamUrl: row.upstream_url ? String(row.upstream_url) : null,
    headersAllowlist: toStringArray(row.headers_allowlist),
    version: Number(row.version),
    configHash: String(row.config_hash),
    enabled: Boolean(row.enabled),
    isPublished: Boolean(row.is_published),
    createdBy: String(row.created_by),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export function mapTenantMember(row: Record<string, unknown>): TenantMemberRecord {
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    email: toNullableString(row.email),
    displayName: toNullableString(row.display_name),
    role: assertEnum(row.role, ["owner", "admin", "member"], "membership role"),
    isBetaTester: Boolean(row.is_beta_tester),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

