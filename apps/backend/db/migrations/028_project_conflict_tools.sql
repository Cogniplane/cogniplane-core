-- Make conflict resolution available to tenants that still allow project
-- writes. Tenants that disabled project writes keep their customized list.
UPDATE tenant_settings AS settings
SET enabled_tool_ids = enabled_tool_ids
  || CASE WHEN enabled_tool_ids ? 'project_get_conflict_context'
          THEN '[]'::jsonb ELSE '["project_get_conflict_context"]'::jsonb END
  || CASE WHEN enabled_tool_ids ? 'project_reconcile_conflict'
          THEN '[]'::jsonb ELSE '["project_reconcile_conflict"]'::jsonb END
WHERE settings.enabled_tool_ids ? 'project_write_file'
  AND NOT settings.enabled_tool_ids ?& ARRAY[
    'project_get_conflict_context',
    'project_reconcile_conflict'
  ]::text[];
