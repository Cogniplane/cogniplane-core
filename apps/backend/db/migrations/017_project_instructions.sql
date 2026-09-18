ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT ''
  CHECK (length(instructions) <= 12000);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructions_revision integer NOT NULL DEFAULT 0
  CHECK (instructions_revision >= 0);
