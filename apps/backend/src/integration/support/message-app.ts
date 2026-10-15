// A message app on real stores: the message, approval and session routes over
// the application pool, a Deep Agents runtime adapter, and a fake provider key.
// The model comes from the test file's own `vi.mock("langchain")`, because
// Vitest hoists that call per file.
//
// The message route type names four stores that these tests never reach:
// documents, uploads, provider keys and PII scan runs. They are cast here,
// once, together with the partial tenant settings. A new required store then
// fails the typecheck here, and not at run time in each test.

import Fastify, { type FastifyInstance } from "fastify";
import { onTestFinished, vi } from "vitest";

import type { AppConfig } from "../../config.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import { registerApprovalRoutes } from "../../routes/approvals.js";
import { registerMessageRoutes, type MessageRouteStores } from "../../routes/messages.js";
import { registerSessionRoutes } from "../../routes/sessions.js";
import { ActiveTurnsRegistry } from "../../services/active-turns-registry.js";
import { AuditEventStore } from "../../services/audit-event-store.js";
import { ApprovalStore } from "../../services/auth/approval-store.js";
import { ToolExecutionContextStore } from "../../services/auth/tool-execution-context-store.js";
import { createDeepAgentsSessionRuntime } from "../../services/deep-agents/deep-agents-graph.js";
import { DeepAgentsRuntimeAdapter } from "../../services/deep-agents/deep-agents-runtime-adapter.js";
import type {
  DeepAgentsCheckpointSaver,
  DeepAgentsRuntimeFactory
} from "../../services/deep-agents/deep-agents-types.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import type { ManagedToolCatalog } from "../../services/managed-tools/catalog.js";
import { MessageStore } from "../../services/message-store.js";
import { ProjectStore } from "../../services/project-store.js";
import { RuntimeSessionStore } from "../../services/runtime/runtime-session-store.js";
import { SessionExecutionStore } from "../../services/session-execution-store.js";
import { SessionStore } from "../../services/session-store.js";
import type { TenantSettingsRecord } from "../../services/tenant-settings-store.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { testRuntimePolicy } from "../../test-helpers/test-runtime-policy.js";
import { appPool } from "./database.js";

export interface MessageAppStores {
  sessions: SessionStore;
  messages: MessageStore;
  executions: SessionExecutionStore;
  projects: ProjectStore;
  approvals: ApprovalStore;
  auditEvents: AuditEventStore;
  toolContexts: ToolExecutionContextStore;
}

export interface MessageAppOptions {
  tenantId: string;
  /** Read on every request. A test changes the caller by assigning to it. */
  auth: { userId: string; admin?: boolean };
  config?: AppConfig;
  /** Replaces the default runtime config. It gets the stores, to read through them. */
  compileRuntimeConfig?: (stores: MessageAppStores) => DynamicConfigService["compileRuntimeConfig"];
  /** Replaces the default runtime. The app records each `init` before it calls this. */
  runtimeFactory?: DeepAgentsRuntimeFactory;
  checkpointer?: DeepAgentsCheckpointSaver;
  managedToolCatalog?: ManagedToolCatalog;
}

export interface MessageServer {
  app: FastifyInstance;
  runtimeAdapter: DeepAgentsRuntimeAdapter;
}

export async function buildMessageApp(options: MessageAppOptions) {
  const config = options.config ?? createTestConfig();
  const stores: MessageAppStores = {
    sessions: new SessionStore(appPool()),
    messages: new MessageStore(appPool()),
    executions: new SessionExecutionStore(appPool()),
    projects: new ProjectStore(appPool()),
    approvals: new ApprovalStore(appPool()),
    auditEvents: new AuditEventStore(appPool()),
    toolContexts: new ToolExecutionContextStore(appPool())
  };
  const dynamicConfig = {
    compileRuntimeConfig:
      options.compileRuntimeConfig?.(stores) ??
      (async () => ({
        runtimePolicy: testRuntimePolicy, skills: [], mcpServers: [], hash: "message-app", sources: {
          runtimePolicy: { id: "test", version: 1, hash: "test" }, skills: [], mcpServers: []
        }
      })),
    async getOrCreateTenantSettings() {
      // Only the fields that the message route reads on these paths.
      return { enabledProviders: ["openai"], enabledModelIds: null, modelDefaultEfforts: {} } as unknown as TenantSettingsRecord;
    },
    // The sandbox reads the approved hosts from the tenant settings when it checks its network.
    async getRuntimePolicy() { return testRuntimePolicy; }
  };
  const created: Parameters<DeepAgentsRuntimeFactory>[0][] = [];
  const runtimeFactory: DeepAgentsRuntimeFactory = (init) => {
    created.push(init);
    return (options.runtimeFactory ?? createDeepAgentsSessionRuntime)(init);
  };
  const quota = vi.fn(async () => null);
  const evaluateText = vi.fn(async () => ({ action: "allow" as const, reason: "no_findings" as const }));
  // The message route does not reach these stores on the paths under test.
  const unusedStores = {} as Pick<
    MessageRouteStores,
    "artifactProcessor" | "storage" | "getTenantAnthropicApiKey" | "piiScanRuns"
  >;
  const routeStores = {
    ...unusedStores,
    ...stores,
    dynamicConfig,
    hasProviderKey: async () => true,
    limits: { consumeRateLimit: async () => null, consumeTurnQuota: quota, sweepExpired: () => {} },
    customModels: { list: async () => [] },
    artifacts: { listBySession: async () => [] },
    piiProtection: { evaluateText }
  };
  const servers: MessageServer[] = [];

  /** One more server on the same stores, with its own runtime adapter and turn registry. */
  async function addServer(): Promise<MessageServer> {
    const app = Fastify();
    app.decorate("config", config);
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = {
        tenantId: options.tenantId,
        userId: options.auth.userId,
        role: options.auth.admin ? "owner" : "member",
        isAdmin: Boolean(options.auth.admin)
      };
    });
    const runtimeAdapter = new DeepAgentsRuntimeAdapter(config, dynamicConfig, app.log, {
      ...stores,
      conversationMessages: stores.messages,
      runtimeSessions: new RuntimeSessionStore(appPool()),
      checkpointer: options.checkpointer,
      tenantMembers: { isUserBetaTester: async () => false }
    }, {
      hasKey: async () => true, resolveKey: async () => "fake-provider-key", platformProviders: new Set()
    }, runtimeFactory, options.managedToolCatalog);
    const activeTurns = new ActiveTurnsRegistry();
    await registerMessageRoutes(app, { ...routeStores, runtimeAdapter, activeTurns });
    await registerApprovalRoutes(app, { approvals: stores.approvals, sessions: stores.sessions, runtimeAdapter });
    await registerSessionRoutes(app, {
      ...stores, limits: routeStores.limits, activeTurns, runtimeAdapter
    });
    const server = { app, runtimeAdapter };
    servers.push(server);
    return server;
  }

  const first = await addServer();
  // The adapter closes its checkpointer.
  onTestFinished(async () => {
    await Promise.all(servers.map((server) => server.runtimeAdapter.close()));
    await Promise.all(servers.map((server) => server.app.close()));
  });
  const model = AVAILABLE_MODELS.find((entry) => entry.provider === "openai")!.id;

  return {
    ...first,
    stores,
    config,
    created,
    quota,
    evaluateText,
    addServer,
    send: (sessionId: string, text: string, server: FastifyInstance = first.app) =>
      server.inject({ method: "POST", url: "/messages", payload: { sessionId, text, model } })
  };
}
