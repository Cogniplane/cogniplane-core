ALTER TABLE projects ADD COLUMN IF NOT EXISTS capability_selection jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS capability_version integer NOT NULL DEFAULT 0;
