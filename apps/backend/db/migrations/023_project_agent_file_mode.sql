ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_file_mode text NOT NULL DEFAULT 'read-only'
  CHECK (agent_file_mode IN ('read-only', 'create-only', 'read-write'));
