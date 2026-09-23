import { expect, test } from "vitest";
import { ToolContextUnavailableError } from "../auth/tool-execution-context-store.js";
import { resolveBoundToolContext } from "./tool-context-binder.js";

test.each([new Error("database password leaked"), new ToolContextUnavailableError("context")])(
  "context lookup exposes only known domain errors", async (error) => {
    const result = await resolveBoundToolContext({
      rpc: { id: 1 }, tenantId: "tenant", args: { toolContextId: "context" },
      urlToolContextId: null, sessionIdFromRuntimeToken: "session",
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
