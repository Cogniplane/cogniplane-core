import { expect, it, vi } from "vitest";

import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";
import { buildManagedToolRegistries } from "../services/managed-tools/build-managed-tools.js";
import { INTERACTIVE_UI_RESOURCE_URI } from "../services/managed-tools/interactive-ui.js";
import { PolicyBlockedError } from "../services/policy/policy-service.js";

it("reopens a saved managed widget only with current session, server, tool, URI, and policy access", async () => {
  const input = { title: "Spending", description: "Travel is the largest category.",
    html: '<script>document.addEventListener("DOMContentLoaded", () => {});</script><p>Travel</p>' };
  const saved = { serverId: "managed-session-context", toolName: "render_interactive_ui", input: "{truncated",
    app: { resourceUri: INTERACTIVE_UI_RESOURCE_URI, input, readOnly: true, turnContext: "interactive",
      result: { content: [{ type: "text", text: "Travel is the largest category." }] } } };
  let readable = true;
  let savedCall = true;
  let selected = true;
  let blocked = false;
  const policy = { enabledMcpServers: [saved.serverId], enabledToolIds: [saved.toolName], policyEnforcementMode: "enforce" };
  const gateCompletedToolResource = vi.fn(async () => {
    if (blocked) throw new PolicyBlockedError("Blocked", null);
  });
  const getMcpServerForUser = vi.fn();
  const compileRuntimeConfig = vi.fn(async () => ({ runtimePolicy: policy,
    mcpServers: selected ? [{ id: saved.serverId, mode: "managed" }] : [] }));
  const app = await sessionRoutesApp({
    sessions: { getReadable: async () => readable ? { status: "active", projectId: null } : null },
    messages: { getMcpAppCall: async () => savedCall ? saved : null },
    dynamicConfig: { compileRuntimeConfig, getMcpServerForUser },
    tenantMembers: { isUserBetaTester: async () => false },
    policyService: { gateCompletedToolResource },
    managedToolCatalog: buildManagedToolRegistries().managedToolCatalog
  }, { userId: "viewer" });
  const read = () => app.inject("/sessions/00000000-0000-4000-8000-000000000001/mcp-apps/saved");
  const opened = await read();
  expect(opened.statusCode).toBe(200);
  expect(opened.headers["cache-control"]).toBe("private, no-store");
  expect(opened.json()).toMatchObject({
    resource: { uri: INTERACTIVE_UI_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" },
    input, result: saved.app.result
  });
  expect(opened.json().resource.text).toContain(input.html);
  expect(opened.json().resource._meta).toBeUndefined();
  expect(gateCompletedToolResource).toHaveBeenLastCalledWith(expect.objectContaining({
    category: "interactive-ui", severity: "read_only", turnContext: "interactive", userId: "viewer", tenantId: "tenant"
  }));
  expect(getMcpServerForUser).not.toHaveBeenCalled();
  readable = false;
  expect((await read()).statusCode).toBe(404);
  readable = true;
  savedCall = false;
  expect((await read()).statusCode).toBe(404);
  savedCall = true;
  selected = false;
  expect((await read()).statusCode).toBe(404);
  selected = true;
  policy.enabledMcpServers = [];
  expect((await read()).statusCode).toBe(404);
  policy.enabledMcpServers = [saved.serverId];
  policy.enabledToolIds = [];
  expect((await read()).statusCode).toBe(404);
  policy.enabledToolIds = [saved.toolName];
  saved.app.resourceUri = "ui://spoofed/app.html";
  expect((await read()).statusCode).toBe(404);
  saved.app.resourceUri = INTERACTIVE_UI_RESOURCE_URI;
  blocked = true;
  expect((await read()).statusCode).toBe(404);
  blocked = false;
  saved.app.input = { ...input, html: "a".repeat(64_001) };
  expect((await read()).statusCode).toBe(502);
  saved.app.input = input;
  expect((await read()).json().resource.text).toBe(opened.json().resource.text);
});
