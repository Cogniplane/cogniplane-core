-- MCP Apps slice 2: persist tool-result UI resources (AgenticEntrepriseFramework CopilotKit).
--
-- Slice 1 carried MCP-UI `ui://` resource blocks on the live SSE payload only,
-- so they vanished on session reload. Store them alongside the tool result as
-- jsonb (an array of {uri, mimeType, text?, blob?, ...}) so listBySession can
-- rehydrate the iframe card.
--
-- Nullable, no default: existing rows and non-UI tool calls stay NULL. No RLS
-- or grant changes needed — RLS is tenant_id based and migrate.ts reapplies
-- GRANTs after every run. IF NOT EXISTS keeps re-application safe.

ALTER TABLE public.message_tool_results
  ADD COLUMN IF NOT EXISTS ui_resources jsonb;
