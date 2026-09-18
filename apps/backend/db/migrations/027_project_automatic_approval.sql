-- Migration 025 narrowed the project approval check after automatic mode had
-- no distinct runtime behavior. It also normalized existing automatic rows to
-- organization_default; that data loss is not reversible here, so affected
-- owners must re-select automatic after this migration. The accepted project
-- contract restores the value while keeping organization approval policy and
-- Policy Center enforcement authoritative.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_approval_mode_check;
ALTER TABLE projects ADD CONSTRAINT projects_approval_mode_check
  CHECK (approval_mode IN ('organization_default', 'manual', 'automatic'));
