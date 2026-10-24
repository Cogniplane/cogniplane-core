import { rpcFailure as failure, type McpRpcResponse as RpcResponse } from "../../lib/mcp-upstream-client.js";
import { ToolContextUnavailableError } from "../auth/tool-execution-context-store.js";
import type { RuntimeTokenClaims } from "../auth/runtime-token.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../auth/tool-execution-context-store.js";

export async function resolveBoundToolContext(input: {
  rpc: { id?: string | number | undefined };
  tenantId: string;
  args: Record<string, unknown>;
  /**
   * From the request's trusted `_meta`. When it is present, it is the only
   * source. A `toolContextId` in the arguments is what the model wrote, and
   * this function ignores it.
   */
  metadataToolContextId: string | null;
  urlToolContextId: string | null;
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
}): Promise<{ context: ToolExecutionContext } | { error: RpcResponse }> {
  const {
    rpc, tenantId, args, metadataToolContextId, urlToolContextId, sessionIdFromRuntimeToken, runtimeTokenClaims, toolContexts
  } = input;
  const argToolContextId = typeof args.toolContextId === "string" ? args.toolContextId : "";

  // The model can write neither the metadata nor the URL. When the two name
  // different contexts, the request is broken or forged. Use neither.
  if (metadataToolContextId && urlToolContextId && metadataToolContextId !== urlToolContextId) {
    return { error: failure(rpc.id, -32602, "Invalid params: conflicting tool contexts.") };
  }

  let context: ToolExecutionContext | null;

  try {
    if (metadataToolContextId) {
      context = await toolContexts.require(tenantId, metadataToolContextId);
    } else if (argToolContextId) {
      context = await toolContexts.require(tenantId, argToolContextId);
    } else if (urlToolContextId) {
      context = await toolContexts.require(tenantId, urlToolContextId);
    } else {
      context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    }
  } catch (error) {
    return { error: failure(rpc.id, -32000, error instanceof ToolContextUnavailableError ? error.message : "Tool context lookup failed.") };
  }

  if (!context) {
    return { error: failure(rpc.id, -32602, "toolContextId is required.") };
  }

  // Session fallback can find a newer participant's turn. Every lookup path
  // must bind the context to the token's identity and runtime generation.
  if (context.tenantId !== tenantId || context.tenantId !== runtimeTokenClaims.tid ||
      context.sessionId !== runtimeTokenClaims.sid || context.userId !== runtimeTokenClaims.uid ||
      context.runtimeId !== runtimeTokenClaims.rid) {
    return { error: failure(rpc.id, -32000, "Tool context does not belong to the authenticated runtime session.") };
  }

  return { context };
}
