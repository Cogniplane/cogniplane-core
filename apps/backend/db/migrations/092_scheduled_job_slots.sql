-- Slot identity for scheduled job runs (UserSettingsStore.claimJob).
--
-- scheduled_for is the next_run_at value that a claim took: the slot of the
-- run. The unique index lets each slot of a job have one run row. Rows written
-- before this migration keep NULL; NULLs are distinct in a unique index, so
-- they never conflict.
--
-- A run can also have status 'skipped': the slot came due while an earlier
-- run of the same job was still pending, so it did not run. The claim writes
-- the skipped row with its slot.
--
-- revision counts the owner's saves of the job (UserSettingsStore
-- .updateScheduledJob adds 1). A claim keeps the revision it read. The run's
-- outcome changes consecutive_failures, and the auto-disable turns the job
-- off, only while the job has that revision, so an outcome of an older
-- definition does not count against the owner's newer one.
--
-- CREATE INDEX lets reads continue, but INSERT, UPDATE and DELETE on
-- scheduled_job_runs wait until this transaction commits. On a large install,
-- build the indexes first with CREATE INDEX CONCURRENTLY and the same names;
-- IF NOT EXISTS then keeps them. A concurrent build of the unique index needs
-- the column first: run the ALTER TABLE statements of this file before it.
SET LOCAL statement_timeout = '15min';

ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

ALTER TABLE scheduled_job_runs
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_slot_key
  ON scheduled_job_runs (tenant_id, job_id, scheduled_for);

-- Each claim asks whether the job has a pending run. Without this index the
-- check reads the job's whole run history.
CREATE INDEX IF NOT EXISTS scheduled_job_runs_pending_job_idx
  ON scheduled_job_runs (tenant_id, job_id) WHERE status = 'pending';
