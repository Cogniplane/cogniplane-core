UPDATE public.message_tool_results
SET kind = 'mcp'
WHERE mcp_app IS NOT NULL AND kind = 'command';
