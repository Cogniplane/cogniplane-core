// Runtime SQL only. Operator deletion, migration metadata and checkpointer
// setup use the migration role; cross-tenant retention uses maintenance_user.
// New tables receive no grant until their runtime operations are listed here.
export const APP_USER_GRANTS = {
  "SELECT, UPDATE": ["tenants"],
  "SELECT, INSERT": [
    "users", "platform_events", "audit_events", "resource_activations", "tool_events",
    "policy_decision", "project_file_versions"
  ],
  "SELECT, INSERT, UPDATE": [
    "admin_mcp_servers", "admin_mcp_connection_tests", "admin_mcp_app_csp_requests", "admin_skills",
    "approvals", "artifact_download_tokens", "artifacts", "user_jira_identities",
    "email_outbox", "local_identities", "member_mcp_credentials", "messages", "message_tool_results",
    "model_spending_calls", "model_spending_reservations", "organization_skill_author_updates",
    "organization_skill_submission_attempts", "organization_skill_submissions",
    "personal_capability_defaults", "pii_scan_jobs", "pii_scan_runs", "project_files",
    "project_folders", "projects", "runtime_sessions", "scheduled_job_runs",
    "session_executions", "sessions", "tenant_integrations", "tenant_member_removals",
    "tenant_model_spending_policy", "tenant_org_settings", "tenant_settings",
    "tool_execution_contexts", "user_settings_sections"
  ],
  "SELECT, INSERT, DELETE": [
    "personal_skill_revisions", "project_skill_revisions", "tenant_custom_models"
  ],
  "SELECT, INSERT, UPDATE, DELETE": [
    "admin_mcp_app_csp_approvals", "admin_skill_revisions", "agent_memories", "auth_action_tokens",
    "local_passwords", "personal_skills", "policy_rule", "project_memberships", "project_skills", "scheduled_jobs",
    "tenant_memberships", "user_github_connections", "user_jira_cleanups", "user_jira_connections", "user_microsoft_connections",
    "user_notion_connections", "user_passkeys", "user_recovery_codes", "user_totp_factors"
  ],
  // Tenant workflows enqueue work. Only maintenance_user drains these queues.
  "INSERT": ["project_file_storage_gc", "session_storage_gc", "skill_bundle_storage_gc"]
} as const;

// SELECT ... FOR SHARE needs UPDATE on at least one column. Grant it on the
// tenant key only; RLS refuses a change to another tenant. No content UPDATE.
export const APP_USER_LOCK_GRANTS = ["GRANT UPDATE (tenant_id) ON public.personal_skill_revisions"] as const;

// USAGE permits nextval/currval, but not setval. No sequence belongs to the
// checkpointer: its runtime keys are supplied by the saver.
export const APP_USER_SEQUENCES = [
  "admin_skill_revisions_skill_revision_id_seq", "approvals_id_seq", "artifact_download_tokens_id_seq",
  "artifacts_id_seq", "audit_events_id_seq", "message_tool_results_id_seq", "messages_id_seq",
  "platform_events_id_seq", "resource_activations_id_seq", "runtime_sessions_id_seq",
  "tool_events_id_seq", "tool_execution_contexts_id_seq"
] as const;

export const APP_USER_CHECKPOINT_GRANTS = {
  "SELECT, INSERT, UPDATE, DELETE": ["checkpoints", "checkpoint_writes"],
  "SELECT, INSERT, DELETE": ["checkpoint_blobs"]
} as const;
