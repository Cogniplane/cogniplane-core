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
 * Before a native tool runs (shell, files, delegation), the turn's tool
 * execution context must still be live. This applies to the turn and to
 * delegated work. A model response that arrives after a security change can
 * then start no native tool, on every replica. This middleware leaves out MCP
 * gateway tools, because the gateway checks the same context for each call. The
 * model start callback (model-start-check.ts) checks the model calls and also
 * covers the summaries. This middleware does not stop a command that already
 * runs.
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
