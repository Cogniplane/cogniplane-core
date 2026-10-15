ALTER TABLE public.message_tool_results
  ADD COLUMN IF NOT EXISTS mcp_app jsonb;
