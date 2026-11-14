// A turn calls tools with its owner's tools and credentials. After a security
// change of the owner's local account (here "sign out everywhere"), the MCP
// gateway must refuse the tool calls of a turn that already started, with the
// runtime token that the turn already holds, on every replica. Nothing stops
// the runtime in this test: the database check alone must refuse the call
// (services/auth/security-change.ts).
//
// Real Postgres, the production MCP route, ToolExecutionContextStore and
// LocalAccountService. Only the managed tool is a test tool.

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";

import { runtimeTokenSecret } from "../lib/derived-secrets.js";
import { PasswordHasher } from "../lib/password-hash.js";
import { registerMcpRoutes, type McpRouteStores } from "../routes/mcp.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../services/auth/runtime-token.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { MCP_INVOCATION_META_KEY } from "../services/mcp/invocation-metadata.js";
import { TOOL_CONTEXT_UNAVAILABLE_MESSAGE } from "../services/mcp/tool-context-binder.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../services/managed-tools/factory.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedRuntimeSession, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";
const SERVER = {
  id: "managed-turn-owner", description: "Test tools", mode: "managed" as const, routePath: "/mcp/managed-turn-owner",
  upstreamUrl: null, transportKind: "http" as const, version: 1, hash: "hash-managed-turn-owner"
};
const TOOL = "turn_owner";

function accounts() {
  return new LocalAccountService({
    db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: ORIGIN,
    afterSecurityChange: IGNORE_SECURITY_CHANGE
  });
}

/**
 * The production gateway route with one managed test tool. Records each call that reaches the tool.
 * `integrationCheck` runs in place of the integration check, which each call awaits before its handler.
 */
async function gateway(
  integrationCheck: () => Promise<void> = async () => {}
): Promise<{ app: FastifyInstance; calls: string[]; secret: string }> {
  const config = createTestConfig();
  const calls: string[] = [];
  const catalog = new ManagedToolCatalog();
  catalog.register([{ name: TOOL, description: "Names the turn's owner.", readOnly: true, tenantConfigurable: false, category: "test" }]);
  const registry = new ManagedToolFactoryRegistry();
  registry.register("test", () => [{
    name: TOOL, description: "Names the turn's owner.", readOnly: true, inputSchema: { type: "object", properties: {} },
    handler: async ({ context }) => {
      calls.push(context.userId);
      return { userId: context.userId };
    }
  }]);
  const app = Fastify();
  app.decorate("config", config);
  // The route reads request.auth only for its logs; the runtime token is the credential.
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: "unused", userId: "unused", role: "member", isAdmin: false };
  });
  const secret = runtimeTokenSecret(config.DATA_ENCRYPTION_SECRET);
  await registerMcpRoutes(app, {
    db: appPool(),
    auditEvents: new AuditEventStore(appPool()),
    toolContexts: new ToolExecutionContextStore(appPool()),
    dynamicConfig: { getMcpServerForUser: async () => SERVER, listSkills: async () => [] },
    managedToolCatalog: catalog,
    managedToolFactoryRegistry: registry,
    policyService: { gateAction: async () => {} },
    approvals: {},
    integrationToolCalls: { checkToolCall: async () => { await integrationCheck(); return null; } },
    runtimeTokenSecret: secret
  } as unknown as McpRouteStores);
  await app.ready();
  onTestFinished(() => app.close());
  return { app, calls, secret };
}

/**
 * A scheduled turn in progress: its session, runtime, tool context (with the
 * version that admitted it), and the runtime token it holds.
 */
async function turnInProgress(owner: { tenantId: string; userId: string }, ownerSecurityVersion: number | null, secret: string) {
  const sessionId = await seedSession(owner.tenantId, owner.userId);
  const runtimeId = await seedRuntimeSession(owner.tenantId, owner.userId, sessionId);
  const context = await new ToolExecutionContextStore(appPool()).create({
    tenantId: owner.tenantId, sessionId, userId: owner.userId, runtimeId, runtimePolicyId: testRuntimePolicy.id, messageId: null,
    metadata: {
      runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: [SERVER.id], enabledToolIds: [SERVER.id, TOOL] },
      turnContext: "scheduled"
    },
    ownerSecurityVersion,
    ttlMs: 300_000
  });
  const token = generateRuntimeToken({
    sid: sessionId, tid: owner.tenantId, uid: owner.userId, rid: runtimeId, exp: runtimeTokenExpiry(3_600_000)
  }, secret);
  return { toolContextId: context.toolContextId, token };
}

async function rpc(app: FastifyInstance, turn: { toolContextId: string; token: string }, method: "tools/call" | "tools/list") {
  const response = await app.inject({
    method: "POST",
    url: `/mcp/${SERVER.id}`,
    remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${turn.token}` },
    payload: {
      jsonrpc: "2.0", id: 1, method,
      params: method === "tools/call"
        ? { name: TOOL, arguments: {}, _meta: { [MCP_INVOCATION_META_KEY]: { toolContextId: turn.toolContextId } } }
        : {}
    }
  });
  return response.json() as { result?: { tools?: Array<{ name: string }>; isError?: boolean }; error?: { code: number; message: string } };
}

describe.skipIf(!adminDatabaseUrl())("MCP gateway after a security change of the turn's owner", () => {
  test("refuses the tool calls of a turn that started before the change, with its existing runtime token", async () => {
    const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
      tenantName: "Gateway", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
    });
    const session = await accounts().redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
    const owner = { tenantId: boot.tenantId, userId: boot.userId };
    const { app, calls, secret } = await gateway();
    const turn = await turnInProgress(owner, session.securityVersion, secret);

    // Before the change: the turn lists and calls its tool.
    expect((await rpc(app, turn, "tools/list")).result?.tools?.map((tool) => tool.name)).toEqual([TOOL]);
    const before = await rpc(app, turn, "tools/call");
    expect(before.error).toBeUndefined();
    expect(calls).toEqual([owner.userId]);

    await accounts().revokeSessions(owner.tenantId, owner.userId, owner.userId, META);

    // The same token and context: the tool does not run, and no tool is listed.
    const after = await rpc(app, turn, "tools/call");
    expect(after.error).toMatchObject({ code: -32000, message: TOOL_CONTEXT_UNAVAILABLE_MESSAGE });
    expect(JSON.stringify(after.error)).not.toContain(turn.toolContextId);
    expect((await rpc(app, turn, "tools/list")).result?.tools).toEqual([]);
    expect(calls).toEqual([owner.userId]);
    // The context row stays for the record; only its lookups refuse it.
    expect((await superuserPool().query("SELECT 1 FROM tool_execution_contexts WHERE tool_context_id = $1", [turn.toolContextId])).rowCount).toBe(1);

    // A turn that the new session admits uses its tools.
    const current = (await superuserPool().query("SELECT security_version FROM local_identities WHERE user_id = $1", [owner.userId])).rows[0];
    const next = await turnInProgress(owner, current.security_version, secret);
    expect((await rpc(app, next, "tools/call")).error).toBeUndefined();
    expect(calls).toEqual([owner.userId, owner.userId]);
  });

  test("refuses a tool call that waited for its checks while the change committed", async () => {
    const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
      tenantName: "Gateway", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
    });
    const session = await accounts().redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
    const owner = { tenantId: boot.tenantId, userId: boot.userId };
    // While a gate is set, the integration check of a call waits until the test releases it.
    let gate: { reached: () => void; released: Promise<void> } | null = null;
    const hold = () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { gate = { reached: resolve, released }; });
      return { entered, release };
    };
    const { app, calls, secret } = await gateway(async () => {
      if (!gate) return;
      const { reached, released } = gate;
      reached();
      await released;
    });
    const turn = await turnInProgress(owner, session.securityVersion, secret);

    // Without a change, a call that waited runs.
    let check = hold();
    let pending = rpc(app, turn, "tools/call");
    await check.entered;
    check.release();
    expect((await pending).error).toBeUndefined();
    expect(calls).toEqual([owner.userId]);

    // The change commits while the call waits: the tool does not run.
    check = hold();
    pending = rpc(app, turn, "tools/call");
    await check.entered;
    await accounts().revokeSessions(owner.tenantId, owner.userId, owner.userId, META);
    check.release();
    expect((await pending).error).toMatchObject({ code: -32000, message: TOOL_CONTEXT_UNAVAILABLE_MESSAGE });
    expect(calls).toEqual([owner.userId]);

    // A new call with the same context is refused too.
    gate = null;
    expect((await rpc(app, turn, "tools/call")).error).toMatchObject({ code: -32000, message: TOOL_CONTEXT_UNAVAILABLE_MESSAGE });
    expect(calls).toEqual([owner.userId]);
  });

  test("a local owner's context with no version is refused; a WorkOS owner's context has none and works", async () => {
    const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
      tenantName: "Gateway", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
    });
    await accounts().redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
    const { app, calls, secret } = await gateway();

    const local = await turnInProgress({ tenantId: boot.tenantId, userId: boot.userId }, null, secret);
    expect((await rpc(app, local, "tools/call")).error?.code).toBe(-32000);

    const tenantId = await seedTenant();
    const workosUser = await seedUser();
    await seedMembership(tenantId, workosUser);
    const workos = await turnInProgress({ tenantId, userId: workosUser }, null, secret);
    expect((await rpc(app, workos, "tools/call")).error).toBeUndefined();
    expect(calls).toEqual([workosUser]);
  });
});
