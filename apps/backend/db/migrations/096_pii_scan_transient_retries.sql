-- A scan attempt that stops because object storage is slow or unavailable
-- says nothing about the file. Such a retry does not use the scan budget
-- (max_attempts). `attempts` still goes up by one on each claim: it is the
-- fence that lets only the attempt that holds the claim finish the job
-- (PiiScanJobStore.markCompleted, recordFailure), so it never goes down.
-- The budget is attempts - transient_retries. PiiScanJobStore limits
-- transient_retries with its own cap and a growing delay.
ALTER TABLE pii_scan_jobs
  ADD COLUMN transient_retries integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT pii_scan_jobs_transient_retries_check
    CHECK (transient_retries >= 0 AND transient_retries <= attempts);
