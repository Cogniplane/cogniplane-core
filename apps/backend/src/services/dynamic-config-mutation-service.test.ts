import { describe, it, expect, vi } from "vitest";

import { AdminConfigError } from "./admin-config-error.js";
import { createMcpServer, updateMcpServer } from "./dynamic-config-mutation-service.js";

import type { McpServerStore } from "./mcp-server-store.js";

// The admin route already rejects a credentialed upstreamUrl through
// httpsUrlSchema. These tests pin the SECOND line of defence: this service is
// the persistence boundary, and the store below it takes a bare string, so a
// caller that does not route through the HTTP schema must still be refused
// rather than writing a credential into the plaintext upstream_url column.

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
  enabled: true
};

describe("upstreamUrl credential rejection at the persistence boundary", () => {
  const credentialed = [
    "https://user:pw@mcp.example.com/rpc",
    "https://user@mcp.example.com/rpc",
    "https://user:pw@mcp.example.com/rpc?api_key=SEKRET"
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

  // NEW-1 from the second review: this boundary re-runs the FULL httpsUrlSchema,
  // not just the credential check. A subset would have accepted every URL below
  // while still looking validated.
  //
  // Note what is NOT here: a bare hostname like `https://localhost/rpc` passes
  // this schema, because isPrivateOrReservedHost inspects IP literals rather
  // than resolving names. That is deliberate and layered — ssrfSafeAgent pins
  // DNS at connect time and re-checks the resolved address, which is the only
  // check a rebinding attack cannot walk past anyway.
  const policyViolations: Array<[string, string]> = [
    ["plain http", "http://mcp.example.com/rpc"],
    ["loopback", "https://127.0.0.1/rpc"],
    ["RFC1918", "https://10.0.4.17/rpc"],
    ["link-local IMDS", "https://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "https://[::1]/rpc"],
    ["file scheme", "file:///etc/passwd"],
    ["octal-encoded loopback", "https://0177.0.0.1/rpc"]
  ];

  for (const [label, upstreamUrl] of policyViolations) {
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
});
