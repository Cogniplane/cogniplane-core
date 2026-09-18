import Fastify from "fastify";
import { registerMcpRoutes, type McpRouteStores } from "../routes/mcp.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../services/managed-tools/factory.js";
import { createNotionTools, NOTION_TOOL_CATALOG } from "../services/managed-tools/notion-tools.js";
import { NotionConnectionStore } from "../services/integrations/notion/notion-connection-store.js";
import { NotionConnectionService } from "../services/integrations/notion/notion-connection-service.js";
import { encrypt } from "../lib/crypto-utils.js";
import { runtimeTokenSecret } from "../lib/derived-secrets.js";
import { AVAILABLE_MODELS } from "../domain/models.js";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { registerApprovalRoutes } from "../routes/approvals.js";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";
import { registerMessageRoutes, type MessageRouteStores } from "../routes/messages.js";
import { SessionStore } from "../services/session-store.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { MessageStore } from "../services/message-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { RuntimeSessionStore } from "../services/runtime/runtime-session-store.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { DeepAgentsRuntimeAdapter } from "../services/deep-agents/deep-agents-runtime-adapter.js";
import { createDeepAgentsSessionRuntime } from "../services/deep-agents/deep-agents-graph.js";
import type { DeepAgentsRuntimeFactory } from "../services/deep-agents/deep-agents-types.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";

const modelControl = vi.hoisted(() => ({ writeFile: false, notion: false, afterOutput: undefined as (() => Promise<void>) | undefined }));

vi.mock("langchain", async importOriginal => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage, AIMessageChunk } = await import("@langchain/core/messages");
  class ControlledModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async *_streamResponseChunks(...args: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      if (!modelControl.writeFile && !modelControl.notion) this.chunks = [];
      yield* super._streamResponseChunks(...args);
      await modelControl.afterOutput?.();
    }
  }
  return { ...actual, initChatModel: async () => new ControlledModel({ sleep: 0,
    responses: [new AIMessage("Saved reply.")],
    chunks: modelControl.writeFile ? [new AIMessageChunk({ content: "", tool_calls: [{
      name: "write_file", id: "write-1", args: { file_path: "/blocked.txt", content: "Do not write" }
    }] })] : modelControl.notion ? [new AIMessageChunk({ content: "", tool_calls: [{
      name: "notion_search", id: "notion-1", args: { query: "Project source", toolContextId: "model-supplied-wrong-context" }
    }] })] : []
  }) };
});

async function setup(personalNotion = false) {
  modelControl.notion = false;
  modelControl.writeFile = false;
  modelControl.afterOutput = undefined;
  const tenantId = await seedTenant(), ownerId = await seedUser(), editorId = await seedUser(), viewerId = await seedUser();
  for (const userId of [ownerId, editorId, viewerId]) await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool()), members = new ProjectMemberStore(appPool());
  const project = await projects.create(tenantId, ownerId, "Shared runtime");
  const actor = { tenantId, userId: ownerId, projectId: project.projectId };
  await members.setMember(actor, editorId, "editor");
  await members.setMember(actor, viewerId, "viewer");
  const sessionId = (await projects.createSession(tenantId, ownerId, project.projectId, "Shared conversation"))!;
  const sessions = new SessionStore(appPool()), messages = new MessageStore(appPool());
  const executions = new SessionExecutionStore(appPool()), toolContexts = new ToolExecutionContextStore(appPool());
  const auditEvents = new AuditEventStore(appPool());
  const app = Fastify();
  const config = createTestConfig({ NOTION_OAUTH_CLIENT_ID: "test-notion-client", NOTION_OAUTH_CLIENT_SECRET: "test-notion-secret", NOTION_OAUTH_REDIRECT_URI: "http://localhost/notion/callback" });
  app.decorate("config", config);
  app.decorate("db", appPool());
  let userId = editorId;
  app.addHook("preHandler", async request => { request.auth = { tenantId, userId, role: "member", isAdmin: false }; });
  const notionServer = { id: "managed-notion", description: "Personal Notion", mode: "managed" as const,
    routePath: "/mcp/managed-notion", upstreamUrl: null, transportKind: "http" as const, version: 1, hash: "test" };
  const runtimePolicy = { ...testRuntimePolicy, enabledMcpServers: personalNotion ? [notionServer.id] : [],
    enabledToolIds: personalNotion ? ["notion_search"] : [] };
  const dynamicConfig = {
    async compileRuntimeConfig(_tenant: string, _beta: boolean, session?: { sessionId: string; userId: string }) {
      if (session) await sessions.getCapabilitySelection(tenantId, session.sessionId, session.userId);
      return { runtimePolicy, skills: [], mcpServers: personalNotion ? [notionServer] : [], hash: "shared-runtime-test", sources: {
        runtimePolicy: { id: "test", version: 1, hash: "test" }, skills: [], mcpServers: []
      } };
    },
    async getOrCreateTenantSettings() { return { enabledProviders: ["openai"], enabledModelIds: null, modelDefaultEfforts: {} }; }
  };
  const notionStore = new NotionConnectionStore(appPool());
  const notionConnections = new NotionConnectionService(config, notionStore, auditEvents);
  const gateway = Fastify();
  const catalog = new ManagedToolCatalog();
  if (personalNotion) {
    gateway.decorate("config", config);
    gateway.addHook("preHandler", async request => { request.auth = { tenantId, userId, role: "member", isAdmin: false }; });
    catalog.register(NOTION_TOOL_CATALOG.map(tool => ({ ...tool, tenantConfigurable: false })));
    const registry = new ManagedToolFactoryRegistry();
    registry.register("notion", () => createNotionTools({ notionConnections }).filter(tool => tool.name === "notion_search"));
    await registerMcpRoutes(gateway, {
      db: appPool(), sessions, messages, auditEvents, toolContexts, notionConnections,
      dynamicConfig: { getMcpServer: async () => notionServer, listSkills: async () => [] },
      managedToolCatalog: catalog, managedToolFactoryRegistry: registry,
      policyService: { gateAction: async () => {} }, approvals: new ApprovalStore(appPool()),
      runtimeTokenSecret: runtimeTokenSecret(config.DATA_ENCRYPTION_SECRET)
    } as unknown as McpRouteStores);
    config.RUNTIME_GATEWAY_BASE_URL = await gateway.listen({ port: 0, host: "127.0.0.1" });
  }
  const created: Parameters<DeepAgentsRuntimeFactory>[0][] = [];
  const inputs: unknown[] = [];
  const toolsStarted: string[] = [];
  const runtimeFactory: DeepAgentsRuntimeFactory = init => {
    created.push(init);
    const runtime = createDeepAgentsSessionRuntime(init);
    return { ...runtime, async getAgentForModel(...args) {
      const graph = await runtime.getAgentForModel(...args);
      return { ...graph, async *streamEvents(input, options) {
        inputs.push(input);
        for await (const event of graph.streamEvents(input, options)) {
          if (event.event === "on_tool_start") toolsStarted.push(String(event.name));
          yield event;
        }
      } };
    } };
  };
  const approvals = new ApprovalStore(appPool());
  const makeRuntime = () => new DeepAgentsRuntimeAdapter(config, dynamicConfig, app.log, {
    sessions, messages, conversationMessages: messages, executions, auditEvents,
    approvals, runtimeSessions: new RuntimeSessionStore(appPool()),
    tenantMembers: { isUserBetaTester: async () => false } as never
  } as ConstructorParameters<typeof DeepAgentsRuntimeAdapter>[3], {
    hasKey: async () => true, resolveKey: async () => "fake-provider-key", platformProviders: new Set()
  }, runtimeFactory, catalog);
  const runtimeAdapter = makeRuntime();
  const replicaRuntime = makeRuntime();
  const replica = Fastify();
  replica.decorate("config", config);
  replica.decorate("db", appPool());
  replica.addHook("preHandler", async request => { request.auth = { tenantId, userId, role: "member", isAdmin: false }; });
  const quota = vi.fn(async () => null);
  const messageStores = {
    sessions, projects, messages, executions, toolContexts, auditEvents, dynamicConfig,
    runtimeAdapter, activeTurns: new ActiveTurnsRegistry(), hasProviderKey: async () => true,
    limits: { consumeRateLimit: async () => null, consumeTurnQuota: quota },
    customModels: { list: async () => [] }, artifacts: { listBySession: async () => [] },
    piiProtection: { evaluateText: async () => ({ action: "allow", reason: "no_findings" }) }
  } as unknown as MessageRouteStores;
  for (const [server, runtime] of [[app, runtimeAdapter], [replica, replicaRuntime]] as const) {
    const activeTurns = new ActiveTurnsRegistry();
    await registerMessageRoutes(server, { ...messageStores, runtimeAdapter: runtime, activeTurns });
    await registerApprovalRoutes(server, { approvals, runtimeAdapter: runtime });
    await registerSessionRoutes(server, { sessions, messages, executions, auditEvents, activeTurns,
      runtimeAdapter: runtime, limits: messageStores.limits } as SessionRouteStores);
  }
  onTestFinished(async () => { await Promise.all([runtimeAdapter.close(), replicaRuntime.close()]); await Promise.all([app.close(), replica.close(), gateway.close()]); });
  const send = (text: string, server = app) => server.inject({ method: "POST", url: "/messages", payload: { sessionId, text, model: AVAILABLE_MODELS.find(model => model.provider === "openai")!.id } });
  return { app, replica, approvals, notionStore, config, tenantId, ownerId, editorId, viewerId, sessionId, sessions, messages, executions, toolContexts,
    created, inputs, toolsStarted, members, actor, send, quota, authenticate(next: string) { userId = next; } };
}

describe.skipIf(!adminDatabaseUrl())("shared message HTTP and runtime", () => {
  test("sequential participants retain saved dialogue with fresh runtime identity and expired prior tool authority", async () => {
    const h = await setup();
    const first = await h.send("Remember the project name Aurora.");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).not.toContain('"type":"RUN_ERROR"');
    const events = first.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events.filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join("")).toBe("Saved reply.");
    h.authenticate(h.ownerId);
    const second = await h.send("Continue the project discussion.");
    expect(second.statusCode, second.body).toBe(200);
    expect(second.body).not.toContain('"type":"RUN_ERROR"');
    expect(h.created.map(init => init.userId)).toEqual([h.editorId, h.ownerId]);
    expect(h.created[0]!.runtimeId).not.toBe(h.created[1]!.runtimeId);
    expect(h.created.every(init => init.checkpointer === undefined)).toBe(true);
    expect(h.inputs[1]).toMatchObject({ messages: [
      { role: "user", content: "Remember the project name Aurora." },
      { role: "assistant", content: "Saved reply." },
      { role: "user", content: expect.stringContaining("Continue the project discussion.") }
    ] });
    const history = await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId);
    expect(history.messages.map(message => message.userId)).toEqual([h.editorId, h.editorId, h.ownerId, h.ownerId]);
    expect((await h.sessions.getReadable(h.tenantId, h.sessionId, h.editorId))!.userId).toBe(h.ownerId);
    const contexts = await superuserPool().query("SELECT tool_context_id FROM tool_execution_contexts WHERE tenant_id=$1 AND session_id=$2", [h.tenantId, h.sessionId]);
    expect(contexts.rows).toHaveLength(2);
    for (const context of contexts.rows) expect(await h.toolContexts.get(h.tenantId, context.tool_context_id)).toBeNull();
    expect(h.quota.mock.calls).toHaveLength(2);
  });

  test("viewers cannot persist messages, spend turn quota or start a runtime", async () => {
    const h = await setup();
    h.authenticate(h.viewerId);
    const response = await h.send("Run a turn");
    expect(response.statusCode, response.body).toBe(403);
    expect(h.created).toHaveLength(0);
    expect(h.quota).not.toHaveBeenCalled();
    expect((await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId)).messages).toEqual([]);
  });

  test("demotion committed during model output prevents its native tool call", async () => {
    const h = await setup();
    modelControl.writeFile = true;
    modelControl.afterOutput = async () => { await h.members.setMember(h.actor, h.editorId, "viewer"); };
    const response = await h.send("Write a file");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"type":"RUN_ERROR"');
    expect(h.toolsStarted).not.toContain("write_file");
    const execution = await superuserPool().query("SELECT status FROM session_executions WHERE tenant_id=$1 AND session_id=$2", [h.tenantId, h.sessionId]);
    expect(execution.rows[0].status).toBe("stopped");
    const history = await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId);
    expect(history.messages.at(-1)?.status).toBe("error");
    modelControl.writeFile = false;
    modelControl.afterOutput = undefined;
    h.authenticate(h.ownerId);
    const next = await h.send("Continue after cancellation");
    expect(next.statusCode, next.body).toBe(200);
    expect(next.body).not.toContain('"type":"RUN_ERROR"');
  });

  test("an approval wait reserves the session across replicas and only its initiator can resume", async () => {
    const h = await setup();
    modelControl.writeFile = true;
    modelControl.afterOutput = async () => { modelControl.writeFile = false; };
    const turn = h.send("Write a file after approval").then(response => response);
    let approvalId = "";
    await vi.waitFor(async () => {
      const pending = await h.approvals.listPending(h.tenantId, h.sessionId, h.editorId);
      expect(pending).toHaveLength(1);
      approvalId = pending[0]!.approvalId;
    }, { timeout: 5000 });
    expect(h.toolsStarted).not.toContain("write_file");
    h.authenticate(h.ownerId);
    const overlapping = await h.send("Overlapping turn", h.replica);
    expect(overlapping.statusCode, overlapping.body).toBe(409);
    expect(h.quota).toHaveBeenCalledTimes(1);
    const url = `/approvals/${approvalId}/decision`;
    expect((await h.replica.inject({ method: "POST", url, payload: { decision: "approve" } })).statusCode).toBe(404);
    expect((await h.replica.inject(`/sessions/${h.sessionId}/approvals`)).json()).toEqual({ approvals: [] });
    h.authenticate(h.editorId);
    expect((await h.replica.inject({ method: "POST", url, payload: { decision: "approve" } })).statusCode).toBe(200);
    const response = await turn;
    expect(response.body).not.toContain('"type":"RUN_ERROR"');
    expect(h.toolsStarted.filter(name => name === "write_file")).toHaveLength(1);
    expect((await h.approvals.get(h.tenantId, approvalId, h.editorId))?.status).toBe("approved");
  });

  test("another owner can cancel an approval wait across replicas without allowing its resume", async () => {
    const h = await setup();
    modelControl.writeFile = true;
    modelControl.afterOutput = async () => { modelControl.writeFile = false; };
    const turn = h.send("Write a file after approval").then(response => response);
    let approvalId = "";
    await vi.waitFor(async () => {
      const pending = await h.approvals.listPending(h.tenantId, h.sessionId, h.editorId);
      expect(pending).toHaveLength(1);
      approvalId = pending[0]!.approvalId;
    }, { timeout: 5000 });
    h.authenticate(h.ownerId);
    expect((await h.replica.inject({ method: "POST", url: `/sessions/${h.sessionId}/interrupt` })).statusCode).toBe(200);
    h.authenticate(h.editorId);
    expect((await h.replica.inject({ method: "POST", url: `/approvals/${approvalId}/decision`, payload: { decision: "approve" } })).statusCode).toBe(404);
    await turn;
    expect(h.toolsStarted).not.toContain("write_file");
    expect((await h.approvals.get(h.tenantId, approvalId, h.editorId))?.status).toBe("expired");
  });

  test("MCP uses each participant's encrypted personal connection without inheriting the previous user's credentials", async () => {
    const h = await setup(true);
    const secret = "test-only-personal-notion-token";
    await h.notionStore.upsert({ tenantId: h.tenantId, userId: h.ownerId, notionUserId: "notion-owner",
      notionWorkspaceId: "workspace", notionWorkspaceName: "Test workspace", notionWorkspaceIcon: null,
      notionBotId: null, notionOwnerEmail: null, notionOwnerName: null, tokenType: "bearer", grantedScopes: [],
      accessTokenEncrypted: encrypt(secret, h.config.DATA_ENCRYPTION_SECRET), accessTokenExpiresAt: null,
      refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null });
    const realFetch = globalThis.fetch;
    const headers: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      if (String(input).startsWith("https://api.notion.com/")) {
        headers.push(new Headers(options?.headers).get("authorization") ?? "");
        return Response.json({ results: [{ id: "source-page", object: "page", properties: {
          title: { type: "title", title: [{ plain_text: "Shared source result" }] }
        } }], has_more: false, next_cursor: null });
      }
      return realFetch(input, options);
    });
    try {
      const query = async (userId: string) => {
        h.authenticate(userId);
        modelControl.notion = true;
        modelControl.afterOutput = async () => { modelControl.notion = false; };
        const response = await h.send("Search the personal source");
        expect(response.body).not.toContain('"type":"RUN_ERROR"');
        expect(response.body).not.toContain(secret);
        return response;
      };
      await query(h.editorId);
      expect(h.toolsStarted).toContain("notion_search");
      expect(JSON.stringify(await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId))).toContain("No Notion connection found");
      expect(headers).toEqual([]);
      const allowed = await query(h.ownerId);
      expect(allowed.body).toContain("Shared source result");
      expect(headers).toEqual([`Bearer ${secret}`]);
      const deniedAgain = await query(h.editorId);
      expect(deniedAgain.body).toContain("No Notion connection found");
      expect(headers).toHaveLength(1);
      const history = JSON.stringify(await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId));
      expect(history).toContain("Shared source result");
      expect(history).not.toContain(secret);
      expect(h.created.map(init => init.userId)).toEqual([h.editorId, h.ownerId, h.editorId]);
    } finally { fetch.mockRestore(); }
  });

});
