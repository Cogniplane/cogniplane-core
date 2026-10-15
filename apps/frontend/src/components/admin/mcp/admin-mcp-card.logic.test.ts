import { describe, expect, it } from "vitest";

import type { AdminMcpServer } from "@cogniplane/shared-types";
import { deriveMcpServerId, getMcpAvailability, getMcpUpstreamWarnings } from "./admin-mcp-card.logic";

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
