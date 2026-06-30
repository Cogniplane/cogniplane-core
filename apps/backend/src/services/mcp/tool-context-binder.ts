import { rpcFailure as failure, type McpRpcResponse as RpcResponse } from "../../lib/mcp-upstream-client.js";
import { getErrorMessage } from "../../lib/http-errors.js";
import type { RuntimeTokenClaims } from "../auth/runtime-token.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../auth/tool-execution-context-store.js";

export async function resolveBoundToolContext(input: {
  rpc: { id?: string | number | undefined };
  tenantId: string;
  args: Record<string, unknown>;
  urlToolContextId: string | null;
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
  toolContexts: ToolExecutionContextStore;
}): Promise<{ context: ToolExecutionContext } | { error: RpcResponse }> {
  const { rpc, tenantId, args, urlToolContextId, sessionIdFromRuntimeToken, runtimeTokenClaims, toolContexts } = input;
  const argToolContextId = typeof args.toolContextId === "string" ? args.toolContextId : "";

  let context: ToolExecutionContext | null;
  let suppliedByCaller = false;

  try {
    if (argToolContextId) {
      context = await toolContexts.require(tenantId, argToolContextId);
      suppliedByCaller = true;
    } else if (urlToolContextId) {
      context = await toolContexts.require(tenantId, urlToolContextId);
      suppliedByCaller = true;
    } else {
      context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    }
  } catch (error) {
    return { error: failure(rpc.id, -32000, getErrorMessage(error, "Tool context lookup failed.")) };
  }

  if (!context) {
    return { error: failure(rpc.id, -32602, "toolContextId is required.") };
  }

  // Bind a caller-supplied context id to the authenticated runtime token so a
  // same-tenant caller cannot substitute another user's/session's context.
  if (suppliedByCaller) {
    if (context.sessionId !== runtimeTokenClaims.sid || context.userId !== runtimeTokenClaims.uid) {
      return { error: failure(rpc.id, -32000, "Tool context does not belong to the authenticated runtime session.") };
    }
  }

  return { context };
}
