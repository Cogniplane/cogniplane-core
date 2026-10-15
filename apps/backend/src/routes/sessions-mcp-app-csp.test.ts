import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { MCP_APP_CSP_DIRECTIVES, type CspDeclarationEntry } from "@cogniplane/shared-types";
import { CSP_INTERSECTION_VECTORS } from "@cogniplane/shared-types/csp-source-vectors";

import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";

const URI = "ui://quote-picker/app.html";
const SESSION = "00000000-0000-4000-8000-000000000001";
const CALL = {
  serverId: "quote-server",
  toolName: "show_quote_picker",
  input: '{"seats":80}',
  app: { resourceUri: URI, readOnly: true, result: { content: [{ type: "text", text: "Three quotes" }] } }
};
const ALL_EMPTY = { resourceDomains: [], connectDomains: [], frameDomains: [], baseUriDomains: [] };

type Store = {
  listApproved: (tenantId: string, serverId: string) => Promise<CspDeclarationEntry[]>;
  recordRequested: (tenantId: string, serverId: string, entries: readonly CspDeclarationEntry[]) => Promise<void>;
};

/** A proxy server that declares `declared`, and a route app with the given approval store. */
async function widget(declared: unknown, mcpAppCsp: Store | undefined) {
  const upstream = Fastify();
  upstream.post("/", async (request, reply) => {
    const rpc = request.body as { id: string };
    const meta = declared === undefined ? undefined : { ui: { csp: declared } };
    return reply.header("content-type", "application/json").send({
      jsonrpc: "2.0", id: rpc.id,
      result: { contents: [{ uri: URI, mimeType: "text/html;profile=mcp-app", text: "<p>Quotes</p>", ...(meta ? { _meta: meta } : {}) }] }
    });
  });
  const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(() => upstream.close());
  const app = await sessionRoutesApp({
    sessions: { getReadable: async () => ({ status: "active" as const, projectId: null, userId: "owner" }) },
    messages: { getMcpAppCall: async () => CALL },
    dynamicConfig: {
      getMcpServerForUser: async () => ({ id: "quote-server", mode: "proxy", upstreamUrl, credentialScope: "organization" }),
      compileRuntimeConfig: async () => ({
        runtimePolicy: { enabledMcpServers: ["quote-server"], policyEnforcementMode: "enforce" },
        mcpServers: [{ id: "quote-server", mode: "proxy" }]
      })
    },
    tenantMembers: { isUserBetaTester: async () => false },
    policyService: { gateCompletedToolResource: async () => ({ evaluation: { outcome: "allow" }, enforced: false }) },
    ...(mcpAppCsp ? { mcpAppCsp } : {})
  });
  app.decorate("config", { MCP_UPSTREAM_TIMEOUT_MS: 2000, MCP_UPSTREAM_MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
    DATA_ENCRYPTION_SECRET: "test-data-encryption-secret-32-bytes-minimum" } as typeof app.config);
  return app;
}

async function served(app: Awaited<ReturnType<typeof widget>>) {
  const response = await app.inject(`/sessions/${SESSION}/mcp-apps/saved`);
  expect(response.statusCode).toBe(200);
  return response.json().resource as { _meta?: { ui: { csp: Record<string, unknown> } } };
}

it("gives a server with no approvals no outside domain, whatever it declares", async () => {
  const store: Store = { listApproved: vi.fn(async () => []), recordRequested: vi.fn(async () => undefined) };
  const app = await widget({
    resourceDomains: ["https://cdn.vendor.com"], connectDomains: ["https://api.vendor.com", "wss://live.vendor.com"],
    frameDomains: ["https://embed.vendor.com"], baseUriDomains: ["https://base.vendor.com"]
  }, store);
  const resource = await served(app);
  expect(resource._meta?.ui.csp).toEqual({ ...ALL_EMPTY, approvedDomains: ALL_EMPTY });
});

it("reads the approvals of this tenant and this server only", async () => {
  const store: Store = { listApproved: vi.fn(async () => []), recordRequested: vi.fn(async () => undefined) };
  await served(await widget({ connectDomains: ["https://api.vendor.com"] }, store));
  expect(store.listApproved).toHaveBeenCalledExactlyOnceWith("tenant", "quote-server");
  expect(store.recordRequested).toHaveBeenCalledExactlyOnceWith("tenant", "quote-server",
    [{ directive: "connectDomains", source: "https://api.vendor.com" }]);
});

it("passes only the declared sources that were approved for the same list", async () => {
  const approved: CspDeclarationEntry[] = [
    { directive: "connectDomains", source: "https://*.vendor.com" },
    { directive: "resourceDomains", source: "https://cdn.vendor.com" }
  ];
  const app = await widget({
    connectDomains: ["https://api.vendor.com", "https://attacker.example.net", "https://vendor.com"],
    resourceDomains: ["https://cdn.vendor.com", "https://api.vendor.com"],
    frameDomains: ["https://api.vendor.com"]
  }, { listApproved: async () => approved, recordRequested: async () => undefined });
  const csp = (await served(app))._meta?.ui.csp;
  expect(csp).toEqual({
    connectDomains: ["https://api.vendor.com"],
    resourceDomains: ["https://cdn.vendor.com"],
    frameDomains: [],
    approvedDomains: { resourceDomains: ["https://cdn.vendor.com"], connectDomains: ["https://*.vendor.com"],
      frameDomains: [], baseUriDomains: [] }
  });
});

it("never passes a public suffix wildcard, an address, localhost or a source with a path, even if it is approved", async () => {
  const hostile = ["https://*.com", "https://*.co.uk", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254",
    "https://localhost", "https://db.internal", "https://user@vendor.com", "https://vendor.com/path",
    "https://vendor.com;frame-src *", "http://vendor.com"];
  const store: Store = {
    // Rows like these cannot be written through the admin route, but the check does not assume that.
    listApproved: async () => hostile.map((source) => ({ directive: "connectDomains" as const, source })),
    recordRequested: vi.fn(async () => undefined)
  };
  const app = await widget({ connectDomains: [...hostile, "https://api.vendor.com"] }, store);
  expect((await served(app))._meta?.ui.csp.connectDomains).toEqual([]);
  // Only a source that an administrator could approve is recorded.
  expect(store.recordRequested).toHaveBeenCalledExactlyOnceWith("tenant", "quote-server",
    [{ directive: "connectDomains", source: "https://api.vendor.com" }]);
});

it.each(CSP_INTERSECTION_VECTORS.map((vector) => [vector.name, vector] as const))(
  "applies the shared intersection vector: %s",
  async (_name, vector) => {
    const approved = MCP_APP_CSP_DIRECTIVES.flatMap((directive) =>
      (vector.approved[directive] ?? []).map((source) => ({ directive, source })));
    const app = await widget(vector.declared, { listApproved: async () => approved, recordRequested: async () => undefined });
    const { approvedDomains, ...allowed } = (await served(app))._meta!.ui.csp;
    expect(allowed).toEqual(vector.allowed);
    expect(approvedDomains).toEqual(Object.fromEntries(MCP_APP_CSP_DIRECTIVES.map((key) => [key, vector.approved[key] ?? []])));
  }
);

it("opens the widget with no outside domain when the approvals cannot be read", async () => {
  const store: Store = {
    listApproved: vi.fn(async () => { throw new Error("database offline"); }),
    recordRequested: vi.fn(async () => undefined)
  };
  const csp = (await served(await widget({ connectDomains: ["https://api.vendor.com"] }, store)))._meta?.ui.csp;
  expect(csp).toEqual({ connectDomains: [], approvedDomains: ALL_EMPTY });
});

it("keeps the approved domains when the record of requests cannot be written", async () => {
  const store: Store = {
    listApproved: async () => [{ directive: "connectDomains", source: "https://api.vendor.com" }],
    recordRequested: vi.fn(async () => { throw new Error("database offline"); })
  };
  const csp = (await served(await widget({ connectDomains: ["https://api.vendor.com"] }, store)))._meta?.ui.csp;
  expect(csp?.connectDomains).toEqual(["https://api.vendor.com"]);
});

it("gives no outside domain when no approval store is wired", async () => {
  const csp = (await served(await widget({ connectDomains: ["https://api.vendor.com"] }, undefined)))._meta?.ui.csp;
  expect(csp).toEqual({ connectDomains: [], approvedDomains: ALL_EMPTY });
});

it("adds no policy metadata when the server declares none, and records nothing", async () => {
  const store: Store = { listApproved: vi.fn(async () => []), recordRequested: vi.fn(async () => undefined) };
  for (const declared of [undefined, "https://api.vendor.com", ["https://api.vendor.com"]]) {
    const resource = await served(await widget(declared, store));
    expect(resource._meta).toBeUndefined();
  }
  expect(store.recordRequested).not.toHaveBeenCalled();
});
