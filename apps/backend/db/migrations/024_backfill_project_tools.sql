-- Migration 023 is already published. Backfill tenants that still have the
-- untouched pre-project defaults without overriding customized tool lists.
UPDATE tenant_settings AS settings
SET enabled_tool_ids = enabled_tool_ids || '["project_list_files", "project_read_file", "project_write_file"]'::jsonb
WHERE settings.enabled_tool_ids = '["managed-session-context", "session_context", "list_artifacts", "read_text_artifact", "read_skill_corpus", "write_artifact", "memory_search", "memory_save", "memory_delete"]'::jsonb;
