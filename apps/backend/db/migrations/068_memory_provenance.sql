-- Provenance and versions for long-term memories (agent_memories).
--
-- Until now the agent could save a memory with no recorded approval, and no
-- column said where a memory came from. Memory text reaches model input on later
-- turns, so a poisoned write has to be traceable. These columns are written by
-- the server only. The model-supplied `metadata` column stays as it was and is
-- never proof of approval.
--
--   provenance           'unverified'     saved before approvals were recorded;
--                                         nothing shows that the user saw the text
--                        'agent_approved' the agent proposed the text and the
--                                         user approved that exact text
--                        'user_authored'  the user wrote or edited it in settings
--   source_session_id    session in which the agent proposed it. No foreign key:
--                        deleting a chat must neither delete nor block a memory
--   approved_by_user_id  the user who approved or wrote the text
--   approval_id          the approvals row that authorized the write
--   approved_at          when the user approved or wrote it
--   version              +1 on every write. An edit and an approved overwrite
--                        compare it, so neither replaces newer text unseen
--
-- Existing rows keep 'unverified'. The settings view marks them for review.
-- RLS is unchanged: agent_memories_tenant_isolation is tenant_id based and
-- covers every column, and migrate.ts reapplies the table GRANTs after each run.
ALTER TABLE agent_memories
  ADD COLUMN provenance text NOT NULL DEFAULT 'unverified'
    CHECK (provenance IN ('unverified', 'agent_approved', 'user_authored')),
  ADD COLUMN source_session_id text,
  ADD COLUMN approved_by_user_id text,
  ADD COLUMN approval_id text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

-- A row cannot claim an approval it has no record of.
ALTER TABLE agent_memories
  ADD CONSTRAINT agent_memories_provenance_complete CHECK (
    (provenance = 'unverified'
      AND source_session_id IS NULL AND approved_by_user_id IS NULL
      AND approval_id IS NULL AND approved_at IS NULL)
    OR (provenance = 'agent_approved'
      AND source_session_id IS NOT NULL AND approved_by_user_id IS NOT NULL
      AND approval_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (provenance = 'user_authored'
      AND source_session_id IS NULL AND approval_id IS NULL
      AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  );
