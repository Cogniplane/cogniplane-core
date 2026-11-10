import { describe, expect, it } from "vitest";

import type { AdminMcpServer } from "@cogniplane/shared-types";
import { deriveMcpServerId, getMcpAvailability, getMcpUpstreamWarnings, mustReenterMcpSecret } from "./admin-mcp-card.logic";

describe("MCP setup", () => {
  it("derives a unique ID from the name", () => {
    expect(deriveMcpServerId("Research Database", ["research-database"])).toBe("research-database-2");
  });

  it.each([
    [false, false, false, "Off"],
    [true, false, false, "Off"],
    [true, true, false, "Available to test users"],
    [true, true, true, "Available to members"]
  ])("derives effective availability from all gates", (enabled, isAllowed, isPublished, label) => {
    const server = {
      enabled, isAllowed, isPublished, mode: "proxy", upstreamUrl: "https://example.com/mcp",
      upstreamAuthType: "none", upstreamAuthConfigured: false
    } as AdminMcpServer;
    expect(getMcpAvailability(server).label).toBe(label);
  });

  it("shows missing authentication as incomplete setup", () => {
    const server = {
      enabled: true, isAllowed: true, isPublished: true, mode: "proxy",
      upstreamUrl: "https://example.com/mcp", upstreamAuthType: "bearer", upstreamAuthConfigured: false
    } as AdminMcpServer;
    expect(getMcpAvailability(server)).toMatchObject({ label: "Setup incomplete", blocker: "Add an authentication secret." });
  });
});

describe("MCP upstream warnings", () => {
  it("warns about both risks for a Tailscale HTTP address", () => {
    expect(getMcpUpstreamWarnings("http://100.108.24.234:3108/mcp")).toEqual({
      http: true,
      privateNetwork: true
    });
  });

  it.each([
    "http://10.0.4.17/mcp",
    "http://192.168.1.5/mcp",
    "http://localhost:3108/mcp",
    "http://server.local/mcp",
    "http://server.tailnet.ts.net/mcp",
    "http://[::1]:3108/mcp"
  ])("warns about a local address at %s", (url) => {
    expect(getMcpUpstreamWarnings(url).privateNetwork).toBe(true);
  });

  it("does not warn for a public HTTPS address", () => {
    expect(getMcpUpstreamWarnings("https://mcp.example.com/mcp")).toEqual({
      http: false,
      privateNetwork: false
    });
  });
});

describe("mustReenterMcpSecret", () => {
  const saved = {
    serverId: "s", ownerTenantId: "t", serverName: "S", description: null, mode: "proxy", routePath: "/mcp/s",
    upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "bearer", upstreamAuthName: null,
    upstreamAuthConfigured: true, credentialScope: "organization", transportKind: "http", enabled: true,
    isAllowed: true, isPublished: false, version: 1, configHash: "a".repeat(64), createdBy: "a",
    createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z"
  } as AdminMcpServer;
  const draft = {
    mode: "proxy" as const, upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "bearer" as const,
    upstreamAuthName: "", credentialScope: "organization" as const
  };

  it.each([
    ["the same origin and method", {}, false],
    ["a new path on the same origin", { upstreamUrl: "https://vendor.example/v2" }, false],
    ["another host", { upstreamUrl: "https://collector.example/mcp" }, true],
    ["another port", { upstreamUrl: "https://vendor.example:8443/mcp" }, true],
    ["another auth type", { upstreamAuthType: "query" as const, upstreamAuthName: "key" }, true],
    ["no auth", { upstreamAuthType: "none" as const }, false],
    ["personal credentials", { credentialScope: "personal" as const }, false]
  ])("%s: %s", (_name, change, expected) => {
    expect(mustReenterMcpSecret(saved, { ...draft, ...change })).toBe(expected);
  });

  it("asks for nothing on a new server or a server with no saved secret", () => {
    expect(mustReenterMcpSecret(undefined, { ...draft, upstreamUrl: "https://collector.example" })).toBe(false);
    expect(mustReenterMcpSecret({ ...saved, upstreamAuthConfigured: false }, { ...draft, upstreamUrl: "https://collector.example" })).toBe(false);
  });

  it("compares the header name", () => {
    const header = { ...saved, upstreamAuthType: "header", upstreamAuthName: "X-API-Key" } as AdminMcpServer;
    expect(mustReenterMcpSecret(header, { ...draft, upstreamAuthType: "header", upstreamAuthName: "X-API-Key" })).toBe(false);
    expect(mustReenterMcpSecret(header, { ...draft, upstreamAuthType: "header", upstreamAuthName: "X-Other" })).toBe(true);
  });
});
