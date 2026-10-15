import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";

import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";
import { PolicyBlockedError } from "../services/policy/policy-service.js";
import { proxySignatureSecret } from "../lib/derived-secrets.js";
import { proxyServerSigningKey, verifyProxyHeaders } from "../lib/mcp-proxy-signature.js";

const URI = "ui://quote-picker/app.html";
const ALLOWED = "00000000-0000-4000-8000-000000000001";
const DENIED = "00000000-0000-4000-8000-000000000002";
const CALL = {
  serverId: "quote-server",
  toolName: "show_quote_picker",
  input: '{"seats":80}',
  app: { resourceUri: URI, readOnly: true, result: { content: [{ type: "text", text: "Three quotes" }], structuredContent: { quotes: [1, 2, 3] } } }
};

it("reads only a saved app call in a readable session and filters resource metadata", async () => {
  const upstream = Fastify();
  const reads: Array<{ body: unknown; headers: Record<string, unknown> }> = [];
  let resourceHtml = "<p>Quotes</p>";
  let resourceMimeType = "text/html;profile=mcp-app";
  let resourceDomain = "https://quotes.vendor.com";
  const approvedSources = [{ directive: "connectDomains" as const, source: "https://quotes.vendor.com" }];
  upstream.post("/", async (request, reply) => {
    reads.push({ body: request.body, headers: request.headers });
    const rpc = request.body as { id: string };
    const response = {
      jsonrpc: "2.0", id: rpc.id,
      result: { contents: [{
        uri: URI, mimeType: resourceMimeType, text: resourceHtml,
        _meta: { ui: { csp: { connectDomains: [resourceDomain, "http://127.0.0.1:80"] } }, secret: "unrelated" }
      }] }
    };
    return reply.header("content-type", "text/event-stream")
      .send(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  });
  const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(() => upstream.close());
  const getReadable = vi.fn(async (_tenant: string, sessionId: string) =>
    sessionId === ALLOWED ? { status: "active" as const, projectId: null, userId: "owner" } : null);
  let savedInput = CALL.input;
  let structuredInput: Record<string, unknown> | undefined = undefined;
  let readOnly = true;
  let credentialConnected = true;
  let turnContext: "interactive" | "scheduled" | null = null;
  const getMcpAppCall = vi.fn(async (_tenant: string, _session: string, toolCallId: string) =>
    toolCallId === "saved" ? { ...CALL, input: savedInput,
      app: { ...CALL.app, readOnly, turnContext, ...(structuredInput ? { input: structuredInput } : {}) } } : null);
  const policy = { enabledMcpServers: ["quote-server"], policyEnforcementMode: "enforce" };
  const evaluation = { outcome: "allow" };
  const gateCompletedToolResource = vi.fn(async (input: { enforcementMode: string }) => {
    if (input.enforcementMode === "enforce" && evaluation.outcome === "block") throw new PolicyBlockedError("Blocked", null);
    return { evaluation, enforced: false };
  });
  const isUserBetaTester = vi.fn(async () => false);
  let selection: { connectorIds: string[] } | null = null;
  const compileRuntimeConfig = vi.fn(async (_tenant: string, _beta: boolean, _session: { sessionId: string; userId: string }) => ({
    runtimePolicy: policy,
    mcpServers: policy.enabledMcpServers.includes("quote-server") && (!selection || selection.connectorIds.includes("quote-server"))
      ? [{ id: "quote-server", mode: "proxy" }] : []
  }));
  const app = await sessionRoutesApp({
    sessions: { getReadable, getCapabilitySelection: async () => selection }, messages: { getMcpAppCall },
    dynamicConfig: {
      getMcpServerForUser: async (_tenantId: string, _serverId: string, userId: string) => {
        expect(userId).toBe("user");
        if (!credentialConnected) throw new Error("Credential unavailable");
        return { id: "quote-server", mode: "proxy", upstreamUrl,
          credentialScope: "personal", upstreamAuth: { type: "bearer", secret: "viewer-secret" } };
      },
      compileRuntimeConfig
    },
    tenantMembers: { isUserBetaTester },
    policyService: { gateCompletedToolResource },
    mcpAppCsp: { listApproved: async () => approvedSources, recordRequested: async () => undefined }
  });
  app.decorate("config", { MCP_UPSTREAM_TIMEOUT_MS: 2000, MCP_UPSTREAM_MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
    DATA_ENCRYPTION_SECRET: "test-data-encryption-secret-32-bytes-minimum" } as typeof app.config);
  expect((await app.inject(`/sessions/${DENIED}/mcp-apps/saved`)).statusCode).toBe(404);
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/unknown`)).statusCode).toBe(404);
  expect(reads).toHaveLength(0);
  policy.enabledMcpServers = [];
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(404);
  policy.enabledMcpServers = ["quote-server"];
  selection = { connectorIds: [] };
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(404);
  selection = null;
  evaluation.outcome = "block";
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(404);
  evaluation.outcome = "require_approval";
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(200);
  evaluation.outcome = "allow";
  expect(reads).toHaveLength(1);
  const response = await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`);
  expect(response.statusCode).toBe(200);
  expect(gateCompletedToolResource).toHaveBeenLastCalledWith(expect.objectContaining({ severity: "read_only", turnContext: null }));
  expect(compileRuntimeConfig).toHaveBeenLastCalledWith("tenant", false, { sessionId: ALLOWED, userId: "user" });
  expect(isUserBetaTester).toHaveBeenLastCalledWith("tenant", "user");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({
    resource: { uri: URI, mimeType: "text/html;profile=mcp-app", text: "<p>Quotes</p>",
      _meta: { ui: { csp: { connectDomains: ["https://quotes.vendor.com"], approvedDomains: {
        resourceDomains: [], connectDomains: ["https://quotes.vendor.com"],
        frameDomains: [], baseUriDomains: []
      } } } } },
    input: { seats: 80 }, result: CALL.app.result
  });
  expect(reads[1]?.body).toMatchObject({ method: "resources/read", params: { uri: URI } });
  expect(reads[1]?.headers["x-framework-signature"]).toEqual(expect.any(String));
  expect(reads[1]?.headers["x-framework-tenant-id"]).toBe("tenant");
  expect(reads[1]?.headers["x-framework-user-id"]).toBe("user");
  expect(reads[1]?.headers.authorization).toBe("Bearer viewer-secret");
  expect(reads[1]?.headers.accept).toBe("application/json, text/event-stream");
  const signature = verifyProxyHeaders(
    reads[1]?.headers as Record<string, string | string[] | undefined>,
    JSON.stringify(reads[1]?.body),
    proxyServerSigningKey(proxySignatureSecret("test-data-encryption-secret-32-bytes-minimum"),
      { tenantId: "tenant", serverId: "quote-server" }),
    { serverId: "quote-server", maxAgeMs: 60_000 }
  );
  expect(signature).toMatchObject({ ok: true, tenantId: "tenant", userId: "user", sessionId: ALLOWED });
  resourceHtml = '<script>const key = "Bearer secret-value";</script>';
  const accepted = await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().resource.text).toBe(resourceHtml);
  resourceHtml = '<script>const headers = { Authorization: `Bearer ${token}` }; const path = `?token=${t}&sig=${s}`;</script>';
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(200);
  turnContext = "scheduled";
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(200);
  expect(gateCompletedToolResource).toHaveBeenLastCalledWith(expect.objectContaining({ turnContext: "scheduled" }));
  readOnly = false;
  evaluation.outcome = "block";
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(404);
  expect(gateCompletedToolResource).toHaveBeenLastCalledWith(expect.objectContaining({ severity: "file_change" }));
  evaluation.outcome = "allow";
  savedInput = '{"seats":';
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(502);
  structuredInput = { seats: 80 };
  const structured = await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`);
  expect(structured.statusCode).toBe(200);
  expect(structured.json().input).toEqual({ seats: 80 });
  resourceHtml = "<p>viewer-secret</p>";
  resourceMimeType = "text/html;viewer-secret";
  resourceDomain = "https://viewer-secret.vendor.com";
  approvedSources.push({ directive: "connectDomains", source: resourceDomain });
  const scrubbed = await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`);
  expect(scrubbed.json().resource.text).toBe("<p>[REDACTED]</p>");
  expect(scrubbed.body).not.toContain("viewer-secret");
  credentialConnected = false;
  const priorReads = reads.length;
  expect((await app.inject(`/sessions/${ALLOWED}/mcp-apps/saved`)).statusCode).toBe(404);
  expect(reads).toHaveLength(priorReads);
});
