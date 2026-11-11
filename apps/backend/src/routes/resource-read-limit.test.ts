import Fastify from "fastify";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { registerArtifactRoutes } from "./artifacts.js";
import { registerProjectFileRoutes } from "./project-files.js";
import { registerSessionRoutes } from "./sessions.js";
import { buildManagedToolRegistries } from "../services/managed-tools/build-managed-tools.js";
import { INTERACTIVE_UI_RESOURCE_URI } from "../services/managed-tools/interactive-ui.js";
import { RequestLimits } from "../services/request-limits.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";

const ARTIFACT = "0196f7ca-8d4b-7a70-9f3f-333333333333";
const PROJECT = "0196f7ca-8d4b-7a70-9f3f-111111111111";
const FILE = "0196f7ca-8d4b-7a70-9f3f-222222222222";
const VERSION = "0196f7ca-8d4b-7a70-9f3f-444444444444";
const SESSION = "00000000-0000-4000-8000-000000000001";
const URLS = {
  artifact: `/artifacts/${ARTIFACT}/preview-text`,
  projectFile: `/projects/${PROJECT}/library/files/${FILE}/versions/${VERSION}/preview-text`,
  mcpApp: `/sessions/${SESSION}/mcp-apps/saved`
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** The three route plugins with one real in-memory limiter, as in production. */
async function appWithOneLimiter() {
  const limits = RequestLimits.fromAppConfig(createTestConfig({
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 2,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 3
  }));
  const work = { extractions: 0, configs: 0 };
  const processor = {
    async extractArtifactText() {
      work.extractions += 1;
      return "PDF TEXT";
    }
  };
  const projectFiles = {
    content: vi.fn(async () => ({ name: "plan.pdf", mimeType: "application/pdf", storageKey: "stored-key" }))
  };
  const widgetInput = { title: "Spending", description: "Travel is the largest category.", html: "<p>Travel</p>" };
  const savedCall = {
    serverId: "managed-session-context", toolName: "render_interactive_ui", input: "{}",
    app: { resourceUri: INTERACTIVE_UI_RESOURCE_URI, input: widgetInput, readOnly: true, result: { content: [] } }
  };

  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("config", createTestConfig());
  app.decorate("db", new FakePool().asPool());
  // Identity comes from authentication. Every request has the same source IP,
  // so a limit keyed by IP would refuse the second user too.
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: String(request.headers["x-user-id"]), tenantId: String(request.headers["x-tenant-id"]),
      isAdmin: false, role: "member"
    };
  });
  await registerArtifactRoutes(app, {
    sessions: {},
    artifacts: {
      async getReadable() {
        return { artifactId: ARTIFACT, mimeType: "application/pdf", status: "ready", detail: {} };
      }
    },
    auditEvents: new InMemoryAuditEventStore(),
    storage: {},
    processor,
    limits
  } as never);
  await registerProjectFileRoutes(app, { artifactStorage: {}, artifactProcessor: processor, limits, projectFiles } as never);
  await registerSessionRoutes(app, {
    limits,
    sessions: { getReadable: async () => ({ status: "active", projectId: null }) },
    messages: { getMcpAppCall: async () => savedCall },
    dynamicConfig: {
      getMcpServerForUser: vi.fn(),
      async compileRuntimeConfig() {
        work.configs += 1;
        return {
          runtimePolicy: {
            enabledMcpServers: [savedCall.serverId], enabledToolIds: [savedCall.toolName], policyEnforcementMode: "enforce"
          },
          mcpServers: [{ id: savedCall.serverId, mode: "managed" }]
        };
      }
    },
    tenantMembers: { isUserBetaTester: async () => false },
    policyService: { gateCompletedToolResource: async () => undefined },
    managedToolCatalog: buildManagedToolRegistries().managedToolCatalog
  } as never);

  const read = (route: keyof typeof URLS, userId: string, tenantId: string) =>
    app.inject({ method: "GET", url: URLS[route], headers: { "x-user-id": userId, "x-tenant-id": tenantId } });
  return { read, work };
}

it("PDF previews and MCP App resources draw on one budget per user and one per tenant", async () => {
  const { read, work } = await appWithOneLimiter();

  expect((await read("artifact", "u1", "t1")).statusCode).toBe(200);
  expect((await read("projectFile", "u1", "t1")).statusCode).toBe(200);
  // A third route does not start a new budget for the same user.
  const userLimited = await read("mcpApp", "u1", "t1");
  expect(userLimited.statusCode).toBe(429);
  expect(userLimited.json()).toMatchObject({ resource: "resource_read", scope: "user", limit: 2 });
  expect(work.configs).toBe(0);

  // A second member of the tenant has a new user budget but shares the tenant one.
  expect((await read("mcpApp", "u2", "t1")).statusCode).toBe(200);
  expect(work.configs).toBe(1);
  const tenantLimited = await read("artifact", "u2", "t1");
  expect(tenantLimited.statusCode).toBe(429);
  expect(tenantLimited.json()).toMatchObject({ resource: "resource_read", scope: "tenant", limit: 3 });
  expect(work.extractions).toBe(2);

  // Another tenant has its own budget.
  expect((await read("projectFile", "u3", "t2")).statusCode).toBe(200);
  expect(work.extractions).toBe(3);
});
