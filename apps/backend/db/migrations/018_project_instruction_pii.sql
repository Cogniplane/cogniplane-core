ALTER TABLE pii_scan_runs ADD COLUMN IF NOT EXISTS instructions_revision integer;
ALTER TABLE pii_scan_runs DROP CONSTRAINT IF EXISTS pii_scan_runs_subject_type_check;
ALTER TABLE pii_scan_runs ADD CONSTRAINT pii_scan_runs_subject_type_check
  CHECK (subject_type IN ('message', 'artifact', 'project_instructions'));
ALTER TABLE pii_scan_runs DROP CONSTRAINT IF EXISTS pii_scan_runs_instructions_revision_check;
ALTER TABLE pii_scan_runs ADD CONSTRAINT pii_scan_runs_instructions_revision_check
  CHECK ((subject_type = 'project_instructions' AND instructions_revision IS NOT NULL AND instructions_revision >= 0)
    OR (subject_type <> 'project_instructions' AND instructions_revision IS NULL));
