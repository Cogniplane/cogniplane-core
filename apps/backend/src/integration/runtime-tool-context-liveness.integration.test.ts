// A turn runs on one replica. A security change of its owner is made on
// another replica, so the stop call (stopActiveWork) does not reach the
// runtime of the turn. The turn must still stop before its next native tool
// or model call, with the reason that the user sees, because the runtime
// reads its tool execution context at those points (bead
// q4w0.19).
//
// Real Postgres, the production message route, Deep Agents adapter and graph,
// ToolExecutionContextStore and LocalAccountService. Only the model is fake.

import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { stopActiveWork } from "../services/auth/security-change.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { buildMessageApp } from "./support/message-app.js";

const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";
const META: RequestMeta = { ipAddress: null, userAgent: "integration" };

// The first model call lists the files (a native tool with no approval and no
// sandbox), then runs `afterFirstCall`. The second model call answers.
const model = vi.hoisted(() => ({ calls: 0, afterFirstCall: undefined as (() => Promise<void>) | undefined }));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessageChunk } = await import("@langchain/core/messages");
  const { ChatGenerationChunk } = await import("@langchain/core/outputs");
  class TwoStepModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async *_streamResponseChunks(...[, , runManager]: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      model.calls += 1;
      const text = model.calls === 1 ? "" : "Second step.";
      const chunk = new ChatGenerationChunk({ text, message: model.calls === 1
        ? new AIMessageChunk({ content: "", tool_calls: [{ name: "ls", id: "ls-1", args: { path: "/" } }] })
        : new AIMessageChunk({ content: text }) });
      yield chunk;
      // streamEvents reports text from this callback.
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
      if (model.calls === 1) await model.afterFirstCall?.();
    }
  }
  return { ...actual, initChatModel: async () => new TwoStepModel({}) };
});

/** A local owner with a session and an empty standalone conversation. */
async function localOwner() {
  const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
    tenantName: "Liveness", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
  });
  await accounts(async () => {}).redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
  // The message route takes a UUID session id.
  const sessionId = randomUUID();
  await superuserPool().query(
    `INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ($1, $2, $3, 'Liveness')`,
    [sessionId, boot.tenantId, boot.userId]);
  return { tenantId: boot.tenantId, userId: boot.userId, sessionId };
}

function accounts(afterSecurityChange: ConstructorParameters<typeof LocalAccountService>[0]["afterSecurityChange"]) {
  return new LocalAccountService({
    db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: ORIGIN, afterSecurityChange
  });
}

/** Two replicas on the same database. The turn runs on the first. */
async function replicas(owner: { tenantId: string; userId: string }) {
  model.calls = 0;
  model.afterFirstCall = undefined;
  const messageApp = await buildMessageApp({ tenantId: owner.tenantId, auth: { userId: owner.userId } });
  const other = await messageApp.addServer();
  const liveness = vi.spyOn(messageApp.stores.toolContexts, "liveness");
  return { messageApp, other, liveness };
}

function events(body: string): Array<{ type: string; delta?: string; result?: unknown }> {
  return body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

async function assistantRow(owner: { tenantId: string; sessionId: string }) {
  const { rows } = await superuserPool().query(
    `SELECT status, detail_json->>'stopReason' AS stop_reason FROM messages
     WHERE tenant_id = $1 AND session_id = $2 AND role = 'assistant'`, [owner.tenantId, owner.sessionId]);
  return rows;
}

describe.skipIf(!adminDatabaseUrl())("a turn whose tool context ended, on a replica that the stop call did not reach", () => {
  test("a tool call that the model returns after the owner signs out everywhere on another replica does not start", async () => {
    const owner = await localOwner();
    const { messageApp, other, liveness } = await replicas(owner);
    const stopped: string[][] = [];
    model.afterFirstCall = async () => {
      // The stop call goes to the other replica, which runs nothing for the owner.
      await accounts(stopActiveWork({
        runtimes: { invalidateRuntimesForUser: async (...args) => {
          const sessionIds = await other.runtimeAdapter.invalidateRuntimesForUser(...args);
          stopped.push(sessionIds);
          return sessionIds;
        } },
        logger: createSilentLogger()
      })).revokeSessions(owner.tenantId, owner.userId, owner.userId, META);
    };

    const response = await messageApp.send(owner.sessionId, "List the files, then answer.");

    expect(response.statusCode, response.body).toBe(200);
    expect(stopped).toEqual([[]]);
    // The check at the model start passed; the check before the tool did not.
    expect(model.calls).toBe(1);
    expect(liveness).toHaveBeenCalledTimes(2);
    const stream = events(response.body);
    expect(stream.some((event) => event.type === "TOOL_CALL_START")).toBe(false);
    expect(stream.map((event) => event.delta ?? "").join("")).not.toContain("Second step.");
    expect(stream.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { interrupted: true, reason: "security_change" } });
    expect(await assistantRow(owner)).toEqual([{ status: "interrupted", stop_reason: "security_change" }]);
    // The runtime stays warm; only the turn ended.
    expect(messageApp.runtimeAdapter.hasSession(owner.sessionId)).toBe(true);
  });

  test("stops with tool_context_ended when the context expired", async () => {
    const owner = await localOwner();
    const { messageApp } = await replicas(owner);
    model.afterFirstCall = async () => {
      await superuserPool().query(
        "UPDATE tool_execution_contexts SET expires_at = now() - interval '1 second' WHERE session_id = $1", [owner.sessionId]);
    };

    const response = await messageApp.send(owner.sessionId, "List the files, then answer.");

    expect(response.statusCode, response.body).toBe(200);
    expect(model.calls).toBe(1);
    const stream = events(response.body);
    expect(stream.some((event) => event.type === "TOOL_CALL_START")).toBe(false);
    expect(stream.at(-1)).toMatchObject({
      type: "RUN_FINISHED", result: { interrupted: true, reason: "tool_context_ended" }
    });
    expect(await assistantRow(owner)).toEqual([{ status: "interrupted", stop_reason: "tool_context_ended" }]);
  });

  test("a live context costs one read per model call and per native tool, and the turn completes", async () => {
    const owner = await localOwner();
    const { messageApp, liveness } = await replicas(owner);

    const response = await messageApp.send(owner.sessionId, "List the files, then answer.");

    expect(response.statusCode, response.body).toBe(200);
    expect(model.calls).toBe(2);
    // Two model starts and one `ls`.
    expect(liveness).toHaveBeenCalledTimes(3);
    const stream = events(response.body);
    expect(stream.map((event) => event.delta ?? "").join("")).toContain("Second step.");
    expect(stream.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect((stream.at(-1)!.result as { interrupted?: boolean } | undefined)?.interrupted).toBeUndefined();
    expect(await assistantRow(owner)).toEqual([{ status: "completed", stop_reason: null }]);
  });
});
