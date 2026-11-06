-- The tool call that an approval is for. The runtime gives each tool call that
-- the model proposes an ID of its own, and the tool card, the saved tool result
-- and this column use it. The browser shows the decision controls in that card.
-- The model's call ID is never stored here: models repeat them. NULL: the link
-- is not known (delegated work, a repeated model call ID, and every existing
-- row), and the browser shows the approval in the notification list.
--
-- A nullable column with no default changes only the catalog.
ALTER TABLE approvals ADD COLUMN tool_call_id text;
