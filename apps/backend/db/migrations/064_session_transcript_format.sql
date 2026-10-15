-- The history format of each session's transcript.
--
-- Format 2 is the structured history that GET /sessions/:id/connect converts
-- for CopilotKit: positioned reasoning segments, and tool calls with text
-- offsets. Sessions that existed before this migration keep NULL: they belong
-- to the previous history format. The chat does not continue or reopen them,
-- and their rows stay stored unchanged. New sessions get format 2 from the
-- column default. This migration updates no row.
--
-- No CHECK constraint: a newer replica can write a later format during a
-- rolling deploy, and this version reads it as unsupported. RLS is tenant_id
-- based, and migrate.ts reapplies the table GRANTs after every run.
ALTER TABLE sessions ADD COLUMN transcript_format smallint;
ALTER TABLE sessions ALTER COLUMN transcript_format SET DEFAULT 2;
