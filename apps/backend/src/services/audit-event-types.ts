// Single source of truth for `audit_events.event_type` values.
//
// Every `auditEvents.create({ type: ... })` call resolves through
// `AuditEventStore.create`, which takes `type: AuditEventType`. Adding a type is
// a one-file change. A typo or a stale name then fails the build at the call
// site. Without this check, it would become an audit row that monitoring
// silently ignores.
//
// The list groups types by domain. Two groups of names do not follow the dotted
// pattern. They predate this enum, and renaming them would break log-based
// monitoring:
//   - /auth/callback emits `role_changed`, which has no domain prefix.
//   - `artifact_uploaded`, `artifact_generated`, and `artifact_downloaded` use
//     snake_case, not the `artifact.*` form.
//
// The list gives types built from template literals in full. A construction site can
// cast with `as AuditEventType`, and consumers still get the type checks.

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
  // Emitted by routes/admin/admin-mcp-server-routes.ts.
  "admin.mcp_server.created",
  "admin.mcp_server.updated",
  "admin.mcp_server.disabled",
  "admin.mcp_server.published",
  "admin.mcp_server.unpublished",
  "admin.mcp_server.widget_domain_approved",
  "admin.mcp_server.widget_domain_revoked",
  "admin.artifact.download_token_minted",
  // Emitted by routes/admin/admin-model-routes.ts.
  "admin.custom_model.created",
  "admin.custom_model.deleted",
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

  // Interrupt cleanup emits `expired`. `resolveApproval` emits `approved` or
  // `rejected`, based on the user's decision.
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  // Emitted when a "remember for this turn" decision auto-approves a later
  // action of the same kind. The auto-approval writes no prompt or DB row, so
  // this event is the only audit trace.
  "approval.auto_approved",

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

  "auth.refresh_token_reuse_detected",
  "role_changed",
  // The app keeps its own role when the WorkOS role slug differs. IdP changes do
  // not propagate after provisioning, so this event shows revocations. They are
  // not errors.
  "role_sync_divergence",
  // Local accounts (docs/ARCHITECTURE.md, "Authentication"). `login_failed` is
  // written only for an existing account: an unknown email has no tenant.
  // Payloads never hold a password, token, or hash.
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.account_setup_completed",
  "auth.password_changed",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.sessions_revoked",
  "auth.step_up",
  "auth.owner_recovered",
  "auth.mfa_enrolled",
  "auth.mfa_removed",
  "auth.passkey_added",
  "auth.passkey_removed",
  "auth.recovery_code_used",
  "auth.recovery_codes_regenerated",

  // MCP gateway egress-control refusals (CIDR allowlist / per-runtime IP
  // pin) — a leaked rt_* token replayed from an unexpected peer is refused.
  "mcp.gateway.rejected",

  "pii_blocked",
  "pii_transformed",
  "pii_reported",
  // The PII block succeeded, but deleting the stored object bytes failed. This
  // event makes the leftover object queryable. Without it, the data-perimeter
  // guarantee of block mode is silently violated. A future sweep uses this event.
  "pii_block_object_orphaned",
  // An invalid stored PII policy stops content in scope. This is not a finding.
  // This outcome detects no PII and deletes nothing.
  "pii_policy_invalid",

  // `recorded` is a monitor-mode or non-gating evaluation. `enforced` gated the
  // action.
  "policy.decision.recorded",
  "policy.decision.enforced",
  // `requested` fires when an enforce-mode require_approval routes a human
  // approval at the gateway. The resolution reuses the shared approval.approved,
  // approval.rejected, and approval.expired events, tagged with
  // `source: "policy"` in the payload.
  "policy.approval.requested",
  "admin.policy_rule.created",
  "admin.policy_rule.updated",
  "admin.policy_rule.deleted",
  "admin.policy_rule.reordered",

  "scheduler.job.run.completed",
  "scheduler.job.run.failed",
  "scheduler.job.disabled",

  // Written in the same transaction as the change (routes/tenant.ts).
  "tenant.renamed",
  "tenant.provider_key.updated",
  "tenant.marketplace_url.updated",
  "tenant.pii_protection.updated",
  "tenant.member.role_changed",
  "tenant.member.removed",
  "tenant.member.created",
  "tenant.member.password_reset",
  "tenant.member.link_resent",
  "tenant.member.disabled",
  "tenant.member.enabled",
  "tenant.member.sessions_revoked",
  "tenant.member.mfa_reset",
  "tenant.security_policy.changed",

  "tenant.integration.config_cleared",
  "tenant.integration.runtime_invalidated",
  "tenant.integration.updated",

  "session.archived",
  "session.restored",
  "session.deleted",

  "turn.interrupted",

  "user.github.connected",
  "user.github.disconnected",
  "user.github.repositories_updated",
  // The owner confirmed a connection that a security change suspended.
  "user.github.confirmed",
  "user.notion.connected",
  "user.notion.disconnected",
  "user.notion.confirmed",
  "user.jira.connected",
  "user.jira.disconnected",
  "user.jira.cleanup_completed",
  "user.jira.cleanup_failed",

  "user.scheduled_job.created",
  "user.scheduled_job.updated",
  "user.scheduled_job.deleted",

  // Written by routes/memories.ts.
  "user.memory.updated",
  "user.memory.deleted",

  "user.settings.updated"
] as const;

// Event types that an overlay emits through the same audit pipeline. Core does
// not name them. An overlay adds its names with module augmentation, so that
// its `auditEvents.create` calls typecheck:
//
//   declare module "<path to this file>.js" {
//     interface OverlayAuditEventTypes {
//       "user.example.connected": true;
//     }
//   }
//
// The same stability rule applies: do not rename an event type after release.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- overlays augment this interface.
export interface OverlayAuditEventTypes {}

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number] | keyof OverlayAuditEventTypes;
