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
  "personal_capabilities_changed",
  "member.mcp_credential.saved",
  "member.mcp_credential.removed",
  "personal.skill.created",
  "personal.skill.draft_saved",
  "personal.skill.released",
  "personal.skill.disabled",
  "personal.skill.deleted",
  "organization.skill_submission.created",
  "organization.skill_submission.withdrawn",
  "organization.skill_submission.resubmitted",
  "organization.skill_submission.changes_requested",
  "organization.skill_submission.declined",
  "organization.skill_submission.accepted",
  "organization.skill_submission.released",
  "model_spending_policy_updated",
  "model_spending_closed",
  "model_spending_reconciled",
  // Admin — MCP servers (emitted by admin-mcp-server-routes.ts).
  "admin.mcp_server.created",
  "admin.mcp_server.updated",
  "admin.mcp_server.disabled",
  "admin.mcp_server.published",
  "admin.mcp_server.unpublished",
  "admin.mcp_server.widget_domain_approved",
  "admin.mcp_server.widget_domain_revoked",
  "admin.artifact.download_token_minted",
  // Admin — custom models (emitted by admin-model-routes.ts).
  "admin.custom_model.created",
  "admin.custom_model.deleted",
  // Admin — runtime / skill / tenant settings / users.
  "admin.runtime_rollout.executed",
  "admin.skill.activated",
  "admin.skill.cleanup.completed",
  "admin.skill.disabled",
  "admin.skill.imported",
  "admin.skill.published",
  "admin.skill.reviewed",
  "admin.skill.rollback",
  "admin.skill.unpublished",
  "admin.tenant_settings.updated",
  "admin.user.beta_tester_updated",

  // Approval lifecycle (interrupt cleanup uses `expired`; resolveApproval
  // uses `approved`/`rejected` based on the user's decision).
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  // Emitted when a "remember for this turn" decision auto-approves a later
  // action of the same kind without a prompt or a new DB row. Without this the
  // remembered fast path leaves no audit trace of what it approved.
  "approval.auto_approved",

  // Artifact lifecycle. Snake_case retained from pre-enum era.
  "artifact_uploaded",
  "project_file_copied",
  "project_sharing_changed",
  "project_member_changed",
  "project_owner_recovered",
  "project_archived",
  "project_restored",
  "project_reference_removed",
  "project_reference_storage_deleted",
  "project_reference_storage_deletion_failed",
  "project_approval_mode_changed",
  "project_agent_file_mode_changed",
  "project_capabilities_changed",
  "project.skill.created",
  "project.skill.copied",
  "project.skill.draft_saved",
  "project.skill.released",
  "project.skill.disabled",
  "project.skill.deleted",
  "project_file_read",
  "project_file_created",
  "project_folder_created",
  "project_folder_renamed",
  "project_folder_removed",
  "project_file_moved",
  "project_draft_created",
  "project_draft_rewritten",
  "project_draft_promoted",
  "project_draft_retargeted",
  "project_file_version_restored",
  "project_file_trashed",
  "project_file_restored",
  "project_file_retention_deleted",
  "artifact_generated",
  "artifact_downloaded",

  // Auth.
  "auth.refresh_token_reuse_detected",
  "role_changed",
  // App role kept despite a different WorkOS role slug — IdP changes do not
  // propagate after provisioning, so revocations surface here, not as errors.
  "role_sync_divergence",

  // MCP gateway egress-control refusals (CIDR allowlist / per-runtime IP
  // pin) — a leaked rt_* token replayed from an unexpected peer is refused.
  "mcp.gateway.rejected",

  // PII pipeline (action-taken outcomes).
  "pii_blocked",
  "pii_transformed",
  "pii_reported",
  // A PII block succeeded (status flipped) but purging the stored object bytes
  // failed. Makes the residual orphan queryable — block-mode's data-perimeter
  // guarantee is otherwise silently violated. A future sweep keys off this.
  "pii_block_object_orphaned",

  // Policy Center decisions. `recorded` is a monitor-mode (or non-gating)
  // evaluation; `enforced` is one that actually gated the action.
  "policy.decision.recorded",
  "policy.decision.enforced",
  // Policy Center approval routing. `requested` is emitted when an enforce-mode
  // require_approval routes a human approval at the gateway; the resolution
  // reuses the shared approval.approved/rejected/expired events above (tagged
  // `source: "policy"` in the payload).
  "policy.approval.requested",
  // Policy Center rule administration.
  "admin.policy_rule.created",
  "admin.policy_rule.updated",
  "admin.policy_rule.deleted",
  "admin.policy_rule.reordered",

  // Scheduler.
  "scheduler.job.run.completed",
  "scheduler.job.run.failed",
  "scheduler.job.disabled",

  // Tenant organization settings and membership (routes/tenant.ts). Written
  // in the same transaction as the change.
  "tenant.provider_key.updated",
  "tenant.marketplace_url.updated",
  "tenant.pii_protection.updated",
  "tenant.member.role_changed",
  "tenant.member.removed",

  // Tenant-level integration toggles (admin-driven).
  "tenant.integration.config_cleared",
  "tenant.integration.runtime_invalidated",
  "tenant.integration.updated",

  // Session lifecycle.
  "session.archived",
  "session.restored",
  "session.deleted",

  // Runtime turn lifecycle.
  "turn.interrupted",

  // User-driven integration connections.
  "user.github.connected",
  "user.github.disconnected",
  "user.github.repositories_updated",
  "user.notion.connected",
  "user.notion.disconnected",
  "user.jira.connected",
  "user.jira.disconnected",
  "user.jira.cleanup_completed",
  "user.jira.cleanup_failed",
  // Microsoft is wired through the SharePoint overlay (private/) but emits
  // through the same audit pipeline; central enum includes it so the
  // overlay's call sites typecheck.
  "user.microsoft.connected",
  "user.microsoft.disconnected",

  // User-driven scheduled job mutations.
  "user.scheduled_job.created",
  "user.scheduled_job.updated",
  "user.scheduled_job.deleted",

  // User edits and deletes of their own long-term memories (routes/memories.ts).
  "user.memory.updated",
  "user.memory.deleted",

  // User-driven setting changes.
  "user.settings.updated"
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
