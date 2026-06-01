-- Index supporting the cross-session artifact browser (GET /artifacts).
--
-- The browser's default and dominant query filters by (tenant_id, user_id),
-- excludes soft-deleted rows, and orders by (created_at DESC, id DESC) with
-- keyset pagination. No existing index leads with user_id — idx_artifacts_session_id
-- leads with session_id, so a cross-session per-user scan could not use it.
--
-- This composite (tenant_id, user_id, created_at DESC, id DESC) lets the planner
-- satisfy the WHERE + ORDER BY + keyset seek from a single index, and the partial
-- predicate keeps soft-deleted rows out of it. It only accelerates the created_*
-- sorts; name_*/size_*/ILIKE still scan (acceptable at per-user volumes — see
-- docs/research/artifact-browser-plan.md §1).
--
-- Additive and idempotent (IF NOT EXISTS); no data migration.

CREATE INDEX IF NOT EXISTS idx_artifacts_user_created
    ON public.artifacts (tenant_id, user_id, created_at DESC, id DESC)
    WHERE status <> 'deleted';
