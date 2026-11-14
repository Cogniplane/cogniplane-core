-- Indexes for the stalled-upload recovery of the scheduler worker
-- (PiiScanJobStore.listStalledUploads). Each worker tick looks for pending
-- uploads and open scan runs that no job owns. All three indexes are partial:
-- they hold only pending uploads, open scan runs and live jobs, so they stay
-- small.
--
-- CREATE INDEX lets reads continue, but INSERT, UPDATE and DELETE on the table
-- wait until this transaction commits. On a large install, build these indexes
-- first with CREATE INDEX CONCURRENTLY and the same names; IF NOT EXISTS then
-- keeps them.
SET LOCAL statement_timeout = '15min';

CREATE INDEX IF NOT EXISTS artifacts_pending_updated_at_idx
  ON artifacts (updated_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pii_scan_runs_open_updated_at_idx
  ON pii_scan_runs (updated_at) WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS pii_scan_jobs_live_subject_idx
  ON pii_scan_jobs (tenant_id, subject_type, subject_id) WHERE status IN ('queued', 'claimed');
