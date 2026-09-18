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
