import { describe, it, expect, vi } from "vitest";

import { AdminConfigError } from "./admin-config-error.js";
import { createMcpServer, updateMcpServer, validateMcpServerInput } from "./dynamic-config-mutation-service.js";

import type { McpServerStore } from "./mcp-server-store.js";

// The admin route rejects URL credentials. The persistence boundary must do
// the same because the store accepts a bare string and upstream_url is plain text.

function storeSpy() {
  const created = vi.fn(async (_tenantId: string, record: unknown) => record);
  const updated = vi.fn(async (_tenantId: string, record: unknown) => record);
  return {
    store: {
      createMcpServer: created,
      updateMcpServer: updated
    } as unknown as McpServerStore,
    created,
    updated
  };
}

const basePayload = {
  serverId: "srv-1",
  serverName: "Vendor",
  description: null,
  transportKind: "http" as const,
  mode: "proxy" as const,
  routePath: "/mcp/vendor",
  upstreamUrl: "https://mcp.example.com/rpc",
  upstreamAuthType: "none" as const,
  upstreamAuthName: null,
  upstreamAuthSecret: null,
  enabled: true
};

describe("upstreamUrl credential rejection at the persistence boundary", () => {
  const credentialed = [
    "https://user:pw@mcp.example.com/rpc",
    "https://user@mcp.example.com/rpc",
    "https://user:pw@mcp.example.com/rpc?api_key=SEKRET",
    "https://mcp.example.com/rpc?api_key=SEKRET"
  ];

  for (const upstreamUrl of credentialed) {
    it(`refuses create for ${upstreamUrl.replace(/:[^:@/]+@/, ":***@")}`, async () => {
      const { store, created } = storeSpy();

      await expect(
        createMcpServer({
          tenantId: "t1",
          store,
          payload: { ...basePayload, upstreamUrl, actorUserId: "u1" }
        })
      ).rejects.toBeInstanceOf(AdminConfigError);

      // The point of the guard: nothing reached the store.
      expect(created).not.toHaveBeenCalled();
    });

    it(`refuses update for ${upstreamUrl.replace(/:[^:@/]+@/, ":***@")}`, async () => {
      const { store, updated } = storeSpy();

      await expect(
        updateMcpServer({
          tenantId: "t1",
          store,
          payload: { ...basePayload, upstreamUrl }
        })
      ).rejects.toBeInstanceOf(AdminConfigError);

      expect(updated).not.toHaveBeenCalled();
    });
  }

  const invalidUrls: Array<[string, string]> = [
    ["file scheme", "file:///etc/passwd"],
    ["embedded credentials", "http://user:pw@localhost/rpc"]
  ];

  for (const [label, upstreamUrl] of invalidUrls) {
    it(`refuses ${label} at the persistence boundary`, async () => {
      const { store, created } = storeSpy();

      await expect(
        createMcpServer({
          tenantId: "t1",
          store,
          payload: { ...basePayload, upstreamUrl, actorUserId: "u1" }
        })
      ).rejects.toBeInstanceOf(AdminConfigError);

      expect(created).not.toHaveBeenCalled();
    });
  }

  it("refuses a malformed upstreamUrl rather than passing it through", async () => {
    const { store, created } = storeSpy();

    await expect(
      createMcpServer({
        tenantId: "t1",
        store,
        payload: { ...basePayload, upstreamUrl: "not a url", actorUserId: "u1" }
      })
    ).rejects.toBeInstanceOf(AdminConfigError);

    expect(created).not.toHaveBeenCalled();
  });

  it("accepts an ordinary upstream URL, query string included", async () => {
    const { store, created } = storeSpy();

    await createMcpServer({
      tenantId: "t1",
      store,
      payload: {
        ...basePayload,
        upstreamUrl: "https://mcp.example.com/rpc?region=eu",
        actorUserId: "u1"
      }
    });

    expect(created).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://100.108.24.234:3108/mcp",
    "http://10.0.4.17/mcp",
    "http://localhost:3108/mcp",
    "https://[::1]/mcp"
  ])("accepts a local upstream at %s", async (upstreamUrl) => {
    const { store, created } = storeSpy();
    await createMcpServer({
      tenantId: "t1",
      store,
      payload: { ...basePayload, upstreamUrl, actorUserId: "u1" }
    });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("leaves managed servers with no upstreamUrl alone", async () => {
    const { store, created } = storeSpy();

    await createMcpServer({
      tenantId: "t1",
      store,
      payload: {
        ...basePayload,
        mode: "managed",
        upstreamUrl: null,
        actorUserId: "u1"
      }
    });

    expect(created).toHaveBeenCalledTimes(1);
  });

  it("rejects an upstream URL on a managed server", async () => {
    const { store, created } = storeSpy();
    await expect(createMcpServer({
      tenantId: "t1",
      store,
      payload: {
        ...basePayload,
        mode: "managed",
        upstreamUrl: "http://100.108.24.234:3108/mcp",
        actorUserId: "u1"
      }
    })).rejects.toThrow("Managed MCP servers cannot configure an upstreamUrl.");
    expect(created).not.toHaveBeenCalled();
  });

  it("requires a secret for newly configured upstream authentication", async () => {
    const { store, created } = storeSpy();

    await expect(
      createMcpServer({
        tenantId: "t1",
        store,
        payload: {
          ...basePayload,
          upstreamAuthType: "bearer",
          upstreamAuthSecret: null,
          actorUserId: "u1"
        }
      })
    ).rejects.toThrow("requires a secret");
    expect(created).not.toHaveBeenCalled();
  });

  it("rejects custom auth headers reserved by the proxy transport", async () => {
    const { store, created } = storeSpy();

    await expect(
      createMcpServer({
        tenantId: "t1",
        store,
        payload: {
          ...basePayload,
          upstreamAuthType: "header",
          upstreamAuthName: "X-Framework-Signature",
          upstreamAuthSecret: "secret",
          actorUserId: "u1"
        }
      })
    ).rejects.toThrow("reserved");
    expect(created).not.toHaveBeenCalled();
  });

  it("accepts a personal authenticated proxy without a shared secret", async () => {
    const { store, created } = storeSpy();
    await createMcpServer({ tenantId: "t1", store, payload: {
      ...basePayload, upstreamAuthType: "bearer", credentialScope: "personal", actorUserId: "u1"
    } });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("rejects a shared secret and anonymous auth in personal scope", async () => {
    const { store, created } = storeSpy();
    await expect(createMcpServer({ tenantId: "t1", store, payload: {
      ...basePayload, upstreamAuthType: "bearer", upstreamAuthSecret: "shared",
      credentialScope: "personal", actorUserId: "u1"
    } })).rejects.toThrow("cannot store a shared secret");
    await expect(createMcpServer({ tenantId: "t1", store, payload: {
      ...basePayload, upstreamAuthType: "bearer", upstreamAuthSecret: "",
      credentialScope: "personal", actorUserId: "u1"
    } })).rejects.toThrow("cannot store a shared secret");
    await expect(createMcpServer({ tenantId: "t1", store, payload: {
      ...basePayload, credentialScope: "personal", actorUserId: "u1"
    } })).rejects.toThrow("authenticated proxy");
    expect(created).not.toHaveBeenCalled();
  });
});

// Each invalid case changes one field of a valid input, so exactly one check
// can reject it. Removing that check would let the case through.
describe("validateMcpServerInput", () => {
  type Input = Parameters<typeof validateMcpServerInput>[0];
  const proxy: Input = {
    mode: "proxy",
    routePath: "/mcp/vendor",
    upstreamUrl: "https://mcp.example.com/rpc",
    upstreamAuthType: "header",
    upstreamAuthName: "X-Api-Key",
    upstreamAuthSecret: "secret",
    credentialScope: "organization"
  };
  const managed: Input = { mode: "managed", routePath: "/mcp/files", upstreamUrl: null };
  const onCreate = { requireUrlAndSecret: true };
  const onUpdate = { requireUrlAndSecret: false };

  it.each([
    ["a header-authenticated proxy", proxy],
    ["a query-authenticated proxy", { ...proxy, upstreamAuthType: "query", upstreamAuthName: "api_key" }],
    ["a bearer proxy", { ...proxy, upstreamAuthType: "bearer", upstreamAuthName: null }],
    ["an anonymous proxy", { ...proxy, upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthSecret: null }],
    ["a managed server", managed]
  ] as Array<[string, Input]>)("accepts %s", (_case, input) => {
    expect(() => validateMcpServerInput(input, onCreate)).not.toThrow();
  });

  it.each([
    ["a route outside /mcp/", { ...proxy, routePath: "/api/vendor" }, "routePath must start with /mcp/."],
    ["a proxy without an upstream URL", { ...proxy, upstreamUrl: null }, "Proxy MCP servers require an upstreamUrl."],
    ["personal credentials on a managed server", { ...managed, credentialScope: "personal" }, "Personal credentials require an authenticated proxy."],
    // As updates, so the secret-on-create check cannot be what refuses them.
    ["an auth type on a managed server", { ...managed, upstreamAuthType: "bearer" }, "Managed MCP servers cannot configure upstream authentication.", onUpdate],
    ["an auth name on a managed server", { ...managed, upstreamAuthName: "X-Api-Key" }, "Managed MCP servers cannot configure upstream authentication.", onUpdate],
    ["an auth secret on a managed server", { ...managed, upstreamAuthSecret: "secret" }, "Managed MCP servers cannot configure upstream authentication.", onUpdate],
    ["an auth name without an auth type", { ...proxy, upstreamAuthType: "none", upstreamAuthSecret: null }, "upstreamAuthName and upstreamAuthSecret require an upstreamAuthType."],
    ["an auth secret without an auth type", { ...proxy, upstreamAuthType: "none", upstreamAuthName: null }, "upstreamAuthName and upstreamAuthSecret require an upstreamAuthType."],
    ["a header name on bearer auth", { ...proxy, upstreamAuthType: "bearer" }, "Bearer authentication always uses the Authorization header."],
    ["header auth without a name", { ...proxy, upstreamAuthName: null }, "header authentication requires upstreamAuthName."],
    ["query auth without a name", { ...proxy, upstreamAuthType: "query", upstreamAuthName: "" }, "query authentication requires upstreamAuthName."],
    ["an auth name with a space", { ...proxy, upstreamAuthName: "X Api Key" }, "upstreamAuthName contains invalid characters."],
    ["an auth name with a colon", { ...proxy, upstreamAuthName: "X-Api-Key:" }, "upstreamAuthName contains invalid characters."]
  ] as Array<[string, Input, string, typeof onCreate?]>)("rejects %s", (_case, input, message, options = onCreate) => {
    expect(() => validateMcpServerInput(input, options)).toThrow(new AdminConfigError(message));
  });

  // An update keeps the stored URL and secret when the form leaves them empty.
  it("lets an update omit the upstream URL and the secret", () => {
    const keepStored: Input = { ...proxy, upstreamUrl: null, upstreamAuthSecret: null };

    expect(() => validateMcpServerInput(keepStored, onUpdate)).not.toThrow();
    expect(() => validateMcpServerInput({ ...keepStored, upstreamUrl: "https://mcp.example.com/rpc" }, onCreate))
      .toThrow("Proxy MCP upstream authentication requires a secret when first configured.");
  });
});
