// Single source of truth for `audit_events.event_type` values.
//
// Every `auditEvents.create({ type: ... })` call resolves through
// `AuditEventStore.create`, which now declares `type: AuditEventType`.
// Adding a new event type is a single-file change here — typos and stale
// names fail the build at the call site instead of materializing as
// silently-ignored audit rows.
//
// Grouped by domain. Within a domain, ordering follows the dotted
// hierarchy. Two oddities are preserved verbatim because they predate
// this enum and renaming would break log-based monitoring:
//   - `role_changed` (no domain prefix) — emitted from /auth/callback.
//   - `artifact_uploaded` / `_generated` / `_downloaded` use snake_case,
//     not `artifact.*` dotted form.
//
// Dynamically-constructed types (template literals) are listed
// explicitly so the construction site can cast through `as
// AuditEventType` and still get the discipline at consumption.

export const AUDIT_EVENT_TYPES = [
  // Admin — MCP servers (registerAdminCrud emits the dynamic verb suffixes).
  "admin.mcp_server.created",
  "admin.mcp_server.updated",
  "admin.mcp_server.disabled",
  "admin.mcp_server.published",
  "admin.mcp_server.unpublished",
  // Admin — runtime / skill / skill-judge / tenant settings / users.
  "admin.runtime_rollout.executed",
  "admin.skill.activated",
  "admin.skill.cleanup.completed",
  "admin.skill.disabled",
  "admin.skill.imported",
  "admin.skill.improvement_launched",
  "admin.skill.published",
  "admin.skill.reviewed",
  "admin.skill.rollback",
  "admin.skill.unpublished",
  "admin.skill_judge.executed",
  "admin.skill_judge.updated",
  "admin.tenant_settings.updated",
  "admin.user.beta_tester_updated",

  // Approval lifecycle (interrupt cleanup uses `expired`; resolveApproval
  // uses `approved`/`rejected` based on the user's decision).
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",

  // Artifact lifecycle. Snake_case retained from pre-enum era.
  "artifact_uploaded",
  "artifact_generated",
  "artifact_downloaded",

  // Auth.
  "auth.refresh_token_reuse_detected",
  "role_changed",

  // LLM proxy (/llm/anthropic). `forwarded` is one row per upstream
  // request with token usage and latency; `rejected` is the auth-failure
  // counterpart (bad/missing rt_*, expired claim, blocked egress IP).
  "llm.proxy.forwarded",
  "llm.proxy.rejected",

  // PII pipeline (action-taken outcomes).
  "pii_blocked",
  "pii_transformed",
  "pii_reported",

  // Scheduler.
  "scheduler.job.run.completed",
  "scheduler.job.run.failed",

  // Tenant-level integration toggles (admin-driven).
  "tenant.integration.config_cleared",
  "tenant.integration.runtime_invalidated",
  "tenant.integration.updated",

  // Runtime turn lifecycle.
  "turn.interrupted",

  // User-driven integration connections.
  "user.github.connected",
  "user.github.disconnected",
  "user.notion.connected",
  "user.notion.disconnected",
  // Microsoft is wired through the SharePoint overlay (private/) but emits
  // through the same audit pipeline; central enum includes it so the
  // overlay's call sites typecheck.
  "user.microsoft.connected",
  "user.microsoft.disconnected",

  // User-driven scheduled job mutations.
  "user.scheduled_job.created",
  "user.scheduled_job.updated",
  "user.scheduled_job.deleted",

  // User-driven setting changes.
  "user.settings.updated"
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
