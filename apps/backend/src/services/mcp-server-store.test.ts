import { expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";
import { computeConfigHash, decrypt, encrypt } from "../lib/crypto-utils.js";

import { AdminConfigError } from "./admin-config-error.js";
import { McpServerStore } from "./mcp-server-store.js";

const ENCRYPTION_SECRET = "test-encryption-secret-must-be-at-least-32chars!";

test("McpServerStore lists one tenant-preferred row per server ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_mcp_servers", (text) => {
    expect(text).toContain("SELECT DISTINCT ON (server_id)");
    expect(text).toContain("(tenant_id = $2::text) DESC");
    return { rows: [], rowCount: 0 };
  });

  await expect(
    new McpServerStore(pool.asPool(), ENCRYPTION_SECRET).listMcpServers("tenant-1")
  ).resolves.toEqual([]);
});

test("McpServerStore rejects tenant servers that reuse a system server ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_mcp_servers", () => ({
    rows: [{ exists: 1 }],
    rowCount: 1
  }));
  const store = new McpServerStore(pool.asPool(), ENCRYPTION_SECRET);

  await expect(
    store.createMcpServer("tenant-1", {
      serverId: "managed-session-context",
      serverName: "Custom context",
      description: null,
      transportKind: "http",
      mode: "managed",
      routePath: "/mcp/custom-context",
      upstreamUrl: null,
      upstreamAuthType: "none",
      upstreamAuthName: null,
      upstreamAuthSecret: null,
      enabled: true,
      createdBy: "admin"
    })
  ).rejects.toThrow(AdminConfigError);

  expect(pool.queries.some((query) => query.text.includes("INSERT INTO admin_mcp_servers"))).toBe(false);
});

test("McpServerStore encrypts upstream credentials and never returns them from writes", async () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  const pool = new FakePool().onQuery("INSERT INTO admin_mcp_servers", (_text, values) => ({
    rows: [
      {
        tenant_id: "system",
        server_id: values[1],
        server_name: values[2],
        description: values[3],
        transport_kind: values[4],
        mode: values[5],
        route_path: values[6],
        upstream_url: values[7],
        upstream_auth_type: values[8],
        upstream_auth_name: values[9],
        upstream_auth_secret_encrypted: values[10],
        version: 1,
        config_hash: values[11],
        enabled: values[12],
        is_published: false,
        created_by: values[13],
        created_at: now,
        updated_at: now
      }
    ],
    rowCount: 1
  }));
  const store = new McpServerStore(pool.asPool(), ENCRYPTION_SECRET);

  const result = await store.createMcpServer("system", {
    serverId: "secured-proxy",
    serverName: "Secured proxy",
    description: null,
    transportKind: "http",
    mode: "proxy",
    routePath: "/mcp/secured",
    upstreamUrl: "https://vendor.example/mcp",
    upstreamAuthType: "header",
    upstreamAuthName: "X-API-Key",
    upstreamAuthSecret: "plain-secret",
    enabled: true,
    createdBy: "admin"
  });

  const insert = pool.queries.find((query) => query.text.includes("INSERT INTO admin_mcp_servers"));
  const ciphertext = String(insert?.values[10]);
  expect(ciphertext).not.toContain("plain-secret");
  expect(decrypt(ciphertext, ENCRYPTION_SECRET)).toBe("plain-secret");
  expect(insert?.values[11]).toBe(
    computeConfigHash({
      serverId: "secured-proxy",
      serverName: "Secured proxy",
      description: null,
      transportKind: "http",
      mode: "proxy",
      routePath: "/mcp/secured",
      upstreamUrl: "https://vendor.example/mcp",
      upstreamAuthType: "header",
      upstreamAuthName: "X-API-Key",
      upstreamAuthConfigured: true
    })
  );
  expect(result).toMatchObject({
    upstreamAuthType: "header",
    upstreamAuthName: "X-API-Key",
    upstreamAuthConfigured: true
  });
  expect(JSON.stringify(result)).not.toContain("plain-secret");
  expect(result).not.toHaveProperty("upstreamAuthSecret");
});

test.each(["api_key", "x-api-key", "subscription-key", "auth_token"])(
  "McpServerStore migrates the legacy query credential %s before exposing or using it",
  async (credentialName) => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    const legacyRow = {
      tenant_id: "tenant-1",
      server_id: "legacy-proxy",
      server_name: "Legacy proxy",
      description: null,
      transport_kind: "http",
      mode: "proxy",
      route_path: "/mcp/legacy",
      upstream_url: `https://vendor.example/mcp?region=ca&${credentialName}=legacy-secret`,
      upstream_auth_type: "none",
      upstream_auth_name: null,
      upstream_auth_secret_encrypted: null,
      version: 1,
      config_hash: "hash",
      enabled: true,
      is_published: false,
      created_by: "admin",
      created_at: now,
      updated_at: now
    };
    let migratedRow: Record<string, unknown> | null = null;
    let migratedCiphertext: string | null = null;
    const pool = new FakePool()
      .onQuery("UPDATE admin_mcp_servers", (_text, values) => {
        migratedCiphertext = String(values[4]);
        migratedRow = {
          ...legacyRow,
          upstream_url: values[2],
          upstream_auth_type: "query",
          upstream_auth_name: values[3],
          upstream_auth_secret_encrypted: values[4]
        };
        return { rows: [migratedRow], rowCount: 1 };
      })
      .onQuery("FROM admin_mcp_servers", () => ({
        rows: [migratedRow ?? legacyRow],
        rowCount: 1
      }));
    const store = new McpServerStore(pool.asPool(), ENCRYPTION_SECRET);

    const listed = await store.listMcpServers("tenant-1");
    expect(listed[0]).toMatchObject({
      upstreamUrl: "https://vendor.example/mcp?region=ca",
      upstreamAuthType: "query",
      upstreamAuthName: credentialName,
      upstreamAuthConfigured: true
    });
    expect(JSON.stringify(listed)).not.toContain("legacy-secret");

    const runtime = await store.getMcpServer("tenant-1", "legacy-proxy");
    expect(runtime?.upstreamAuth).toEqual({
      type: "query",
      name: credentialName,
      secret: "legacy-secret"
    });
    expect(decrypt(String(migratedCiphertext), ENCRYPTION_SECRET)).toBe(
      "legacy-secret"
    );
  }
);

test("McpServerStore hashes resolved update values and stable auth state", async () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  const encryptedSecret = encrypt("same-secret", ENCRYPTION_SECRET);
  const existing = {
    upstream_url: "https://vendor.example/mcp",
    upstream_auth_type: "bearer",
    upstream_auth_name: null,
    upstream_auth_secret_encrypted: encryptedSecret
  };
  const updateHashes: string[] = [];
  const pool = new FakePool()
    .onQuery("SELECT upstream_url", () => ({ rows: [existing], rowCount: 1 }))
    .onQuery("UPDATE admin_mcp_servers", (_text, values) => {
      updateHashes.push(String(values[10]));
      return {
        rows: [
          {
            tenant_id: "tenant-1",
            server_id: values[0],
            server_name: values[1],
            description: values[2],
            transport_kind: values[3],
            mode: values[4],
            route_path: values[5],
            upstream_url: values[6],
            upstream_auth_type: values[7],
            upstream_auth_name: values[8],
            upstream_auth_secret_encrypted: values[9],
            version: 2,
            config_hash: values[10],
            enabled: values[11],
            is_published: false,
            created_by: "admin",
            created_at: now,
            updated_at: now
          }
        ],
        rowCount: 1
      };
    });
  const store = new McpServerStore(pool.asPool(), ENCRYPTION_SECRET);
  const input = {
    serverId: "secured-proxy",
    serverName: "Secured proxy",
    description: null,
    transportKind: "http" as const,
    mode: "proxy" as const,
    routePath: "/mcp/secured",
    enabled: true
  };

  const preserved = await store.updateMcpServer("tenant-1", input);
  const resubmitted = await store.updateMcpServer("tenant-1", {
    ...input,
    upstreamAuthSecret: "same-secret"
  });
  const expectedHash = computeConfigHash({
    serverId: "secured-proxy",
    serverName: "Secured proxy",
    description: null,
    transportKind: "http",
    mode: "proxy",
    routePath: "/mcp/secured",
    upstreamUrl: "https://vendor.example/mcp",
    upstreamAuthType: "bearer",
    upstreamAuthName: null,
    upstreamAuthConfigured: true
  });

  expect(preserved?.configHash).toBe(expectedHash);
  expect(resubmitted?.configHash).toBe(expectedHash);
  expect(updateHashes).toEqual([expectedHash, expectedHash]);
});
