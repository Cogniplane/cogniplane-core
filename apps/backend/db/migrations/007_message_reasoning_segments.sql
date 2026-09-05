-- Restore reasoning<->turn-body interleaving on AG-UI session reload.
--
-- Live, the AG-UI translator closes the open reasoning message before each tool
-- call (and before assistant text), so a `think → tool → think → tool` turn
-- streams multiple positionally-interleaved reasoning bursts. But persistence
-- flattened all of them into the single `reasoning_content` column, so reload
-- rendered one thinking block ahead of the whole turn body instead of the
-- interleaved layout the user saw live.
--
-- `reasoning_segments` records each reasoning burst as `{ "offset": <int>,
-- "text": <string> }`, where `offset` is the character length of the assistant
-- text accumulated when that burst started (the same convention as
-- `message_tool_results.text_offset`). On reload we merge these with the tool
-- offsets to interleave reasoning, text, and tool cards in stream order.
--
-- Nullable: pre-existing rows and the retired writer (which didn't
-- set it) fall back to the old single-block-then-body layout via
-- `reasoning_content`, which is retained unchanged.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reasoning_segments jsonb;
