import { rpcFailure as failure, type McpRpcResponse as RpcResponse } from "../../lib/mcp-upstream-client.js";
import { ToolContextUnavailableError } from "../auth/tool-execution-context-store.js";
import type { RuntimeTokenClaims } from "../auth/runtime-token.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../auth/tool-execution-context-store.js";

/**
 * Generic message for a tool context that is missing, expired, or ended. It
 * must not name the context ID (see lookupFailure).
 */
export const TOOL_CONTEXT_UNAVAILABLE_MESSAGE =
  "The tool access of this turn was not found, expired, or ended by a security change.";

/** The message when the caller closed the request before the tool action started. */
export const CALLER_CLOSED_MESSAGE = "The caller closed the request. The tool did not run.";

type RpcId = string | number | undefined;

export async function resolveBoundToolContext(input: {
  rpc: { id?: RpcId };
  tenantId: string;
  args: Record<string, unknown>;
  /**
   * From the request's trusted `_meta`. When it is present, it is the only
   * source used. The model writes `args.toolContextId`. The binder uses that
   * value only when `_meta` is absent.
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
    return { error: lookupFailure(rpc.id, error) };
  }

  if (!context) {
    return { error: failure(rpc.id, -32602, "toolContextId is required.") };
  }

  // Session fallback can find a newer participant's turn. Every lookup path
  // must bind the context to the token's identity and runtime generation.
  const unbound = bindingFailure(rpc.id, context, tenantId, runtimeTokenClaims);
  if (unbound) return { error: unbound };

  return { context };
}

/**
 * Read the exact bound context again after asynchronous checks, immediately
 * before the action. `require` checks the owner's security version, TTL and
 * applicable execution state. Never use the session fallback here, since it
 * could find a newer turn's context. Identity fields of a context never change.
 *
 * The lookup and action are not atomic. A revocation that commits after this
 * lookup cannot recall an upstream action. See docs/architecture/tools.md.
 * Returns a refusal, or null when the action can start with the bound context.
 */
export async function revalidateBoundToolContext(input: {
  rpc: { id?: RpcId };
  tenantId: string;
  context: ToolExecutionContext;
  runtimeTokenClaims: RuntimeTokenClaims;
  toolContexts: Pick<ToolExecutionContextStore, "require">;
  callerClosed?: AbortSignal;
}): Promise<RpcResponse | null> {
  const { rpc, tenantId, context, runtimeTokenClaims, toolContexts, callerClosed } = input;
  let current: ToolExecutionContext;
  try {
    current = await toolContexts.require(tenantId, context.toolContextId);
  } catch (error) {
    return lookupFailure(rpc.id, error);
  }
  const unbound = bindingFailure(rpc.id, current, tenantId, runtimeTokenClaims);
  if (unbound) return unbound;
  if (callerClosed?.aborted) return failure(rpc.id, -32000, CALLER_CLOSED_MESSAGE);
  return null;
}

function lookupFailure(id: RpcId, error: unknown): RpcResponse {
  // The model reads this text as the tool result, and the checkpoint keeps it.
  // The error's own message names the trusted context ID, so it stays out.
  return failure(id, -32000, error instanceof ToolContextUnavailableError
    ? TOOL_CONTEXT_UNAVAILABLE_MESSAGE : "Tool context lookup failed.");
}

function bindingFailure(
  id: RpcId,
  context: ToolExecutionContext,
  tenantId: string,
  claims: RuntimeTokenClaims
): RpcResponse | null {
  if (context.tenantId !== tenantId || context.tenantId !== claims.tid ||
      context.sessionId !== claims.sid || context.userId !== claims.uid ||
      context.runtimeId !== claims.rid) {
    return failure(id, -32000, "Tool context does not belong to the authenticated runtime session.");
  }
  return null;
}
