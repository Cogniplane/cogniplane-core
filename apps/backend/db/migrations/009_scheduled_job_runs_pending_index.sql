-- The scheduler worker sweeps for runs orphaned in status='pending' by a
-- crash/restart on every tick. Partial index keeps that steady-state query
-- (zero or near-zero matching rows) from scanning the whole runs table.

CREATE INDEX idx_scheduled_job_runs_pending_sweep
    ON public.scheduled_job_runs USING btree (started_at)
    WHERE status = 'pending';
