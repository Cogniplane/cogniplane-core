-- The PII settings revision that a scan read. A queued scan applies the PII
-- policy that is in force when the job runs, not the policy at enqueue time.
-- The worker records the revision that it read and sets pii_scan_runs.mode to
-- the mode that it applied. pii_scan_jobs.mode keeps the mode at enqueue time.
-- Null: the scan did not record a revision (an older row, or a scan that
-- another path wrote). See PiiScanJobHandler.applyDecision.
--
-- The check is added NOT VALID, so this migration does not read the table
-- while it holds the ACCESS EXCLUSIVE lock of ADD COLUMN. Migration 078
-- validates the existing rows in a separate transaction.
ALTER TABLE pii_scan_runs
  ADD COLUMN policy_revision integer,
  ADD CONSTRAINT pii_scan_runs_policy_revision_check
    CHECK (policy_revision IS NULL OR policy_revision >= 0) NOT VALID;
