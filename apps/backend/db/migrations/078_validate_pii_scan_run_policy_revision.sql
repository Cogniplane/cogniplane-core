-- Validates the check that migration 077 added NOT VALID. The migration
-- runner applies each file in its own transaction, so this scan holds only a
-- SHARE UPDATE EXCLUSIVE lock: reads and writes of pii_scan_runs continue.
-- In the same file as 077, the scan would hold the ACCESS EXCLUSIVE lock of
-- ADD COLUMN until the commit.
ALTER TABLE pii_scan_runs VALIDATE CONSTRAINT pii_scan_runs_policy_revision_check;
