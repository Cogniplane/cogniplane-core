ALTER TABLE projects ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'organization_default'
  CHECK (approval_mode IN ('organization_default', 'manual', 'automatic'));
