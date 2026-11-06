import { createMiddleware } from "langchain";

export function executionAuthorizationMiddleware(requireExecution: () => Promise<void>) {
  return createMiddleware({
    name: "ExecutionAuthorization",
    beforeAgent: async () => { await requireExecution(); },
    wrapModelCall: async (request, handler) => {
      await requireExecution();
      return handler(request);
    },
    wrapToolCall: async (request, handler) => {
      await requireExecution();
      return handler(request);
    }
  });
}

/**
 * Before the dispatch of each native tool (shell, files, delegation), of the
 * turn and of delegated work, the turn's tool execution context must still be
 * live. A model response that arrives after a security change can then start
 * no native tool, on every replica. MCP gateway tools are left out: the
 * gateway checks the same context for each call. The model calls are checked
 * at the model start callback (model-start-check.ts), which also covers the
 * summaries. A command that already runs is not stopped here.
 */
export function toolContextLivenessMiddleware(
  requireLiveToolContext: () => Promise<void>,
  isGatewayTool: (toolName: string) => boolean
) {
  return createMiddleware({
    name: "ToolContextLiveness",
    wrapToolCall: async (request, handler) => {
      if (!isGatewayTool(request.toolCall.name)) await requireLiveToolContext();
      return handler(request);
    }
  });
}
