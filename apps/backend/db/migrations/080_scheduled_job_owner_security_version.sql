-- A scheduled job runs as its owner, with the owner's tools and credentials.
-- A job that a stolen access token saved must stop when the owner changes the
-- password or signs out everywhere. Each job therefore keeps the security
-- version of the owner's local account from the session that last saved it
-- (create or edit). The scheduler compares it with
-- local_identities.security_version before each run and, on a difference,
-- pauses the job (enabled = FALSE, paused_reason = 'security_change'). The
-- owner turns the job on again from a current session, which stores the new
-- version. See UserSettingsStore.claimJob and pauseJobForSecurityChange.
--
-- NULL owner_security_version: for a WorkOS owner, the job is not compared.
-- WorkOS accounts have no security version in this database. For a local
-- owner, NULL is a mismatch, so the job pauses at its next run.
--
-- paused_reason applies only while the job is off. A job that is on ignores
-- it (the API reads it as NULL), and an edit clears it. The check does not
-- tie the reason to `enabled`: during a rolling deploy or after a rollback,
-- older backend code turns a paused job on without clearing the reason, and
-- a CHECK on both columns would refuse that save with an error.
ALTER TABLE scheduled_jobs
  ADD COLUMN owner_security_version integer,
  ADD COLUMN paused_reason text,
  ADD CONSTRAINT scheduled_jobs_paused_reason_check
    CHECK (paused_reason IN ('security_change'));

-- Existing jobs of local owners. Keep the current version only on a job that
-- a session saved at or after the owner's last security change. Every
-- security_version increment sets local_identities.updated_at = now(), and no
-- other write sets that column, so it is the time of the last change.
-- scheduled_jobs.updated_at is not a save time: each claim and each run
-- outcome sets it. A save is the job's creation (created_at) or an edit,
-- which writes the audit event `user.scheduled_job.updated` with the job id.
-- A session that saved at or after the last change carries the current
-- version, so the job keeps running. Every other job of a local owner stays
-- NULL and pauses at its next run, and the owner reviews it. A job without
-- the edit event (for example after audit retention) is judged by its
-- creation only, which can pause it but never keeps it running.
--
-- The comparison adds one minute to the time of the last change. now() is
-- the start time of a transaction, so a save that raced a security change by
-- milliseconds could otherwise look newer than the change. The margin can
-- pause a job that was correctly saved in the minute after a change; it can
-- never keep a planted job running.
--
-- scheduled_jobs is small (each user holds at most
-- SCHEDULED_JOB_MAX_ACTIVE_PER_USER enabled jobs). The audit read uses the
-- (tenant_id, event_type, created_at) index.
-- migrate.ts reapplies the table GRANTs after every run.
UPDATE scheduled_jobs j
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = j.tenant_id
  AND li.user_id = j.user_id
  AND (
    j.created_at >= li.updated_at + INTERVAL '1 minute'
    OR EXISTS (
      SELECT 1
      FROM audit_events a
      WHERE a.tenant_id = j.tenant_id
        AND a.event_type = 'user.scheduled_job.updated'
        AND a.created_at >= li.updated_at + INTERVAL '1 minute'
        AND a.user_id = j.user_id
        AND a.payload->>'jobId' = j.job_id
    )
  );

-- Jobs of local owners that were off before this migration and that the
-- backfill left without a version. A manager's disable or a member removal
-- before this migration turned them off without a reason. Mark them for a
-- review, so the owner sees the prompt before the job runs again.
UPDATE scheduled_jobs j
SET paused_reason = 'security_change'
FROM local_identities li
WHERE li.tenant_id = j.tenant_id
  AND li.user_id = j.user_id
  AND j.enabled = FALSE
  AND j.owner_security_version IS NULL;
