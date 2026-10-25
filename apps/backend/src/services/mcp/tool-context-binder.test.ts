import { describe, expect, test, vi } from "vitest";
import { ToolContextUnavailableError, type ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { resolveBoundToolContext } from "./tool-context-binder.js";

test.each([new Error("database password leaked"), new ToolContextUnavailableError("context")])(
  "context lookup exposes only known domain errors", async (error) => {
    const result = await resolveBoundToolContext({
      rpc: { id: 1 }, tenantId: "tenant", args: { toolContextId: "context" },
      metadataToolContextId: null, urlToolContextId: null, sessionIdFromRuntimeToken: "session",
      runtimeTokenClaims: { jti: "token", sid: "session", tid: "tenant", uid: "user", rid: "runtime" },
      toolContexts: {
        require: async () => { throw error; },
        findLatestActiveBySession: async () => null
      }
    });
    expect(result).toMatchObject({ error: { error: {
      message: error instanceof ToolContextUnavailableError ? error.message : "Tool context lookup failed."
    } } });
    expect(JSON.stringify(result)).not.toContain("database password");
  }
);

describe("context sources", () => {
  const claims = { jti: "token", sid: "session", tid: "tenant", uid: "user", rid: "runtime" };
  const context = (toolContextId: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
    toolContextId, tenantId: "tenant", sessionId: "session", userId: "user", runtimeId: "runtime",
    runtimePolicyId: "policy", messageId: null, credentialEnvelope: {}, metadata: {},
    expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-10-15T00:00:00.000Z", ...overrides
  });
  const contexts = new Map([
    ["ctx_metadata", context("ctx_metadata")],
    ["ctx_argument", context("ctx_argument")],
    ["ctx_url", context("ctx_url")],
    ["ctx_other_user", context("ctx_other_user", { userId: "other-user" })]
  ]);
  function resolve(input: { metadata?: string; argument?: string; url?: string }) {
    const require = vi.fn(async (_tenantId: string, id: string) => {
      const found = contexts.get(id);
      if (!found) throw new ToolContextUnavailableError(id);
      return found;
    });
    const findLatestActiveBySession = vi.fn(async () => context("ctx_latest"));
    const result = resolveBoundToolContext({
      rpc: { id: 1 }, tenantId: "tenant", args: input.argument ? { toolContextId: input.argument } : {},
      metadataToolContextId: input.metadata ?? null, urlToolContextId: input.url ?? null,
      sessionIdFromRuntimeToken: "session", runtimeTokenClaims: claims,
      toolContexts: { require, findLatestActiveBySession }
    });
    return { result, require, findLatestActiveBySession };
  }
  const idOf = async (result: ReturnType<typeof resolve>["result"]) => {
    const resolved = await result;
    return "context" in resolved ? resolved.context.toolContextId : resolved.error;
  };

  test("the metadata context wins over a model-written argument and is the only one read", async () => {
    const { result, require } = resolve({ metadata: "ctx_metadata", argument: "ctx_made_up" });
    expect(await idOf(result)).toBe("ctx_metadata");
    expect(require.mock.calls).toEqual([["tenant", "ctx_metadata"]]);
  });

  test("without metadata, the older sources keep their order", async () => {
    expect(await idOf(resolve({ argument: "ctx_argument", url: "ctx_url" }).result)).toBe("ctx_argument");
    expect(await idOf(resolve({ url: "ctx_url" }).result)).toBe("ctx_url");
    expect(await idOf(resolve({}).result)).toBe("ctx_latest");
  });

  test("a URL context that differs from the metadata context is a conflict, and nothing is looked up", async () => {
    const { result, require, findLatestActiveBySession } = resolve({ metadata: "ctx_metadata", url: "ctx_url" });
    expect(await result).toMatchObject({ error: { error: { code: -32602, message: "Invalid params: conflicting tool contexts." } } });
    expect(require).not.toHaveBeenCalled();
    expect(findLatestActiveBySession).not.toHaveBeenCalled();
    expect(await idOf(resolve({ metadata: "ctx_url", url: "ctx_url" }).result)).toBe("ctx_url");
  });

  test("a metadata context is bound to the token like any other source", async () => {
    expect(await resolve({ metadata: "ctx_other_user" }).result).toMatchObject({ error: { error: {
      code: -32000, message: "Tool context does not belong to the authenticated runtime session." } } });
    expect(await resolve({ metadata: "ctx_missing" }).result).toMatchObject({ error: { error: { code: -32000 } } });
  });
});
