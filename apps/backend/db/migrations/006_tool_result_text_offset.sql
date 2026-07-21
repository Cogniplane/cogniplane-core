-- Restore text<->tool-call interleaving on AG-UI session reload.
--
-- A single assistant turn interleaves text segments with tool calls (text,
-- tool, more text, another tool, final text). The persisted message stores the
-- text merged into one `content` blob and the tool calls as separate
-- `message_tool_results` rows, which loses WHERE each tool call sat relative to
-- the text — so reload rendered all text first, then all tool cards.
--
-- `text_offset` records the character length of the assistant text accumulated
-- at the moment this tool call started. On reload we split `content` at the
-- sorted offsets to recover the segments and interleave them with the cards.
-- Nullable: pre-existing rows (and the legacy RuntimeEvent writer, which doesn't
-- set it) fall back to the old "text then tools" layout.
ALTER TABLE public.message_tool_results
  ADD COLUMN IF NOT EXISTS text_offset integer;
