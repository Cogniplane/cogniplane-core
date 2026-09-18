-- Archiving only changes project-list visibility; member sessions stay usable.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- Match the list predicate for either archive view. Activity ordering still
-- includes member sessions and files, so it cannot use a projects-only index.
CREATE INDEX IF NOT EXISTS projects_owner_archive
  ON projects (tenant_id, user_id, (archived_at IS NOT NULL));
-- Existing idx_artifacts_tenant_session and idx_artifacts_session_id support
-- the file-search join. Substring matches are filtered within those sessions.
