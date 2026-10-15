import { expect, test } from "vitest";
import { decrypt } from "../lib/crypto-utils.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { mapMcpServer } from "./admin-config-store-mappers.js";
import { MemberMcpAccessError, MemberMcpConflictError, MemberMcpCredentialStore,
  MemberMcpNotFoundError, MemberMcpValidationError } from "./member-mcp-credential-store.js";

const encryptionSecret = "test-member-mcp-encryption-secret-long-enough";
const tenantId = "tenant", userId = "alice", serverId = "approved-proxy";
const bindingId = "00000000-0000-4000-8000-000000000001";
const savedAt = new Date("2026-09-20T12:00:00.000Z");

type Credential = { server_id: string; credential_binding_id: string; secret_encrypted: string | null;
  account_label: string | null; version: number; updated_at: Date };
function setup() {
  const state = {
    members: new Map([[userId, false], ["bob", false]]),
    allowed: [serverId],
    server: {
      tenant_id: tenantId, server_id: serverId, server_name: "Approved proxy", description: "Use approved tools",
      transport_kind: "http", mode: "proxy", route_path: `/mcp/${serverId}`,
      upstream_url: "https://vendor.example/mcp", upstream_auth_type: "header",
      upstream_auth_name: "X-API-Key" as string | null,
      upstream_auth_secret_encrypted: null, credential_scope: "personal", credential_binding_id: bindingId,
      version: 4, config_hash: "config-hash", enabled: true, is_published: true,
      created_by: "admin", created_at: savedAt, updated_at: savedAt
    },
    credentials: new Map<string, Credential>(),
    audit: [] as Array<{ type: string; payload: unknown }>
  };
  const pool = new FakePool()
    .onQuery("FROM tenant_memberships", (_sql, values) => {
      const member = state.members.get(String(values[1]));
      return member === undefined ? { rows: [], rowCount: 0 } : {
        rows: [{ is_beta_tester: member }], rowCount: 1
      };
    })
    .onQuery("FROM tenant_settings", () => ({ rows: [{ enabled_mcp_server_ids: state.allowed }], rowCount: 1 }))
    .onQuery("FROM (SELECT DISTINCT ON (server_id) * FROM admin_mcp_servers", () => ({
      rows: [state.server], rowCount: 1
    }))
    .onQuery("FROM admin_mcp_servers", () => ({ rows: [state.server], rowCount: 1 }))
    .onQuery("INSERT INTO member_mcp_credentials", (_sql, values) => {
      const credential: Credential = { server_id: String(values[2]), credential_binding_id: String(values[3]),
        secret_encrypted: String(values[4]), account_label: values[5] as string | null,
        version: Number(values[6]), updated_at: savedAt };
      state.credentials.set(String(values[1]), credential);
      return { rows: [credential], rowCount: 1 };
    })
    .onQuery("UPDATE member_mcp_credentials SET", (sql, values) => {
      const prior = state.credentials.get(String(values[1]));
      if (!prior) throw new Error("Missing test credential");
      prior.secret_encrypted = null;
      // remove() also clears the label and writes the removed binding.
      if (sql.includes("account_label=NULL")) {
        prior.account_label = null;
        prior.credential_binding_id = String(values[3]);
      }
      prior.version += 1;
      return { rows: [{ ...prior }], rowCount: 1 };
    })
    .onQuery("FROM member_mcp_credentials", (_sql, values) => {
      const credential = state.credentials.get(String(values[1]));
      return credential ? { rows: [credential], rowCount: 1 } : { rows: [], rowCount: 0 };
    })
    .onQuery("INSERT INTO audit_events", (_sql, values) => {
      state.audit.push({ type: String(values[4]), payload: JSON.parse(String(values[5])) });
      return { rows: [], rowCount: 1 };
    });
  return { state, pool, store: new MemberMcpCredentialStore(pool.asPool(), encryptionSecret),
    server: () => mapMcpServer(state.server) };
}
const saveInput = { version: 0, serverVersion: 4, secret: "personal-secret", accountLabel: "  My account  " };

test("refuses a departed member before reading settings or credentials", async () => {
  const { state, pool, store, server } = setup();
  state.members.delete(userId);
  await expect(store.list(tenantId, userId)).rejects.toBeInstanceOf(MemberMcpAccessError);
  await expect(store.getStatus(tenantId, userId, server())).rejects.toBeInstanceOf(MemberMcpAccessError);
  await expect(store.getRuntimeCredential(tenantId, userId, server())).rejects.toBeInstanceOf(MemberMcpAccessError);
  await expect(store.save(tenantId, userId, serverId, saveInput)).rejects.toBeInstanceOf(MemberMcpAccessError);
  await expect(store.remove(tenantId, userId, serverId, 0)).rejects.toBeInstanceOf(MemberMcpAccessError);
  expect(pool.queries.some(query => query.text.includes("FROM tenant_settings"))).toBe(false);
  expect(pool.queries.some(query => query.text.includes("member_mcp_credentials"))).toBe(false);
});

test("saves encrypted credentials, returns owner-safe status, and checks versions", async () => {
  const { state, pool, store, server } = setup();
  const saved = await store.save(tenantId, userId, serverId, saveInput);
  expect(saved).toMatchObject({ status: "connected", credentialVersion: 1, accountLabel: "My account",
    hasCredential: true, canConnect: true });
  expect(JSON.stringify(saved)).not.toContain(saveInput.secret);
  const encrypted = state.credentials.get(userId)?.secret_encrypted;
  expect(encrypted).toBeTruthy();
  expect(encrypted).not.toContain(saveInput.secret);
  expect(decrypt(encrypted!, encryptionSecret)).toBe(saveInput.secret);
  expect((await store.list(tenantId, userId))[0]).toMatchObject({ status: "connected", accountLabel: "My account" });
  expect((await store.list(tenantId, "bob"))[0]).toMatchObject({ status: "not_connected", hasCredential: false });
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toEqual({
    auth: { type: "header", name: "X-API-Key", secret: saveInput.secret }, version: 1
  });
  const savedCredential = { ...state.credentials.get(userId) };
  const insertCount = pool.queries.filter(query => query.text.includes("INSERT INTO member_mcp_credentials")).length;
  await expect(store.save(tenantId, userId, serverId, saveInput)).rejects.toBeInstanceOf(MemberMcpConflictError);
  expect(state.credentials.get(userId)).toEqual(savedCredential);
  expect(pool.queries.filter(query => query.text.includes("INSERT INTO member_mcp_credentials"))).toHaveLength(insertCount);
  await expect(store.save(tenantId, userId, serverId, { ...saveInput, version: 1, serverVersion: 3 }))
    .rejects.toBeInstanceOf(MemberMcpConflictError);
  expect(state.credentials.get(userId)).toEqual(savedCredential);
  expect(pool.queries.filter(query => query.text.includes("INSERT INTO member_mcp_credentials"))).toHaveLength(insertCount);
  expect(state.audit).toEqual([{ type: "member.mcp_credential.saved", payload: {
    serverId, version: 1, serverVersion: 4 } }]);
  expect(JSON.stringify(state.audit)).not.toContain(saveInput.secret);
  expect(pool.queries.some(query => query.text.includes("ROLLBACK"))).toBe(true);
});

test("requires current approval and binding before runtime use or a new save", async () => {
  const { state, store, server } = setup();
  await store.save(tenantId, userId, serverId, saveInput);
  const oldServer = server();
  state.server.credential_binding_id = "00000000-0000-4000-8000-000000000002";
  // The read clears the secret for the old binding and bumps the version.
  expect(await store.getStatus(tenantId, userId, oldServer)).toEqual({
    status: "reconnect_required", credentialVersion: 2, accountLabel: "My account" });
  expect(await store.getRuntimeCredential(tenantId, userId, oldServer)).toBeNull();
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toBeNull();
  await store.save(tenantId, userId, serverId, { ...saveInput, version: 2, serverVersion: 4,
    secret: "new-personal-secret" });
  expect(await store.getStatus(tenantId, userId, oldServer)).toMatchObject({ status: "reconnect_required" });
  expect(state.credentials.get(userId)?.version).toBe(3);
  state.allowed = [];
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toBeNull();
  expect((await store.list(tenantId, userId))[0]).toMatchObject({ status: "unavailable", accountLabel: null,
    upstreamUrl: null, hasCredential: true });
  await expect(store.save(tenantId, userId, serverId, { ...saveInput, version: 3 }))
    .rejects.toBeInstanceOf(MemberMcpNotFoundError);
  state.allowed = [serverId];
  state.server.is_published = false;
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toBeNull();
  state.members.set(userId, true);
  expect((await store.getRuntimeCredential(tenantId, userId, server()))?.auth).toMatchObject({ secret: "new-personal-secret" });
});

test("denies a disabled or managed server even when a credential was saved", async () => {
  const { state, pool, store, server } = setup();
  await store.save(tenantId, userId, serverId, saveInput);
  const savedCredential = { ...state.credentials.get(userId) };
  for (const change of [{ enabled: false }, { mode: "managed" }]) {
    state.server.enabled = true;
    state.server.mode = "proxy";
    Object.assign(state.server, change);
    expect(await store.getRuntimeCredential(tenantId, userId, server())).toBeNull();
    expect((await store.list(tenantId, userId))[0]).toMatchObject({
      status: "unavailable", canConnect: false, upstreamUrl: null, hasCredential: true
    });
    await expect(store.save(tenantId, userId, serverId, { ...saveInput, version: 1 }))
      .rejects.toBeInstanceOf(MemberMcpNotFoundError);
    expect(state.credentials.get(userId)).toEqual(savedCredential);
  }
  expect(pool.queries.filter(query => query.text.includes("INSERT INTO member_mcp_credentials"))).toHaveLength(1);
});

test("uses bearer auth for a current inherited system proxy", async () => {
  const { state, pool, store, server } = setup();
  state.server.tenant_id = "system";
  state.server.upstream_auth_type = "bearer";
  state.server.upstream_auth_name = null;
  const saved = await store.save(tenantId, userId, serverId, saveInput);
  expect(saved).toMatchObject({ status: "connected", credentialScope: "personal", authType: "bearer" });
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toEqual({
    auth: { type: "bearer", secret: saveInput.secret }, version: 1
  });
  expect(pool.queries.some(query => query.text.includes("FROM admin_mcp_servers") && query.text.includes("FOR SHARE")))
    .toBe(false);
});

test("keeps tombstone versions and rejects stale removal and save", async () => {
  const { state, pool, store, server } = setup();
  await expect(store.remove(tenantId, userId, serverId, 0)).rejects.toBeInstanceOf(MemberMcpNotFoundError);
  await store.save(tenantId, userId, serverId, saveInput);
  await expect(store.remove(tenantId, userId, serverId, 0)).rejects.toBeInstanceOf(MemberMcpConflictError);
  state.allowed = [];
  await store.remove(tenantId, userId, serverId, 1);
  const removalQuery = pool.queries.find(query => query.text.includes("UPDATE member_mcp_credentials SET"));
  expect(removalQuery?.values).toEqual([tenantId, userId, serverId, "00000000-0000-0000-0000-000000000000"]);
  expect(state.audit[1]).toEqual({ type: "member.mcp_credential.removed", payload: { serverId, version: 2 } });
  expect(state.credentials.get(userId)).toMatchObject({ version: 2, secret_encrypted: null, account_label: null });
  state.allowed = [serverId];
  expect(await store.getStatus(tenantId, userId, server())).toEqual({
    status: "not_connected", credentialVersion: 2, accountLabel: null });
  await expect(store.save(tenantId, userId, serverId, { ...saveInput, version: 1 }))
    .rejects.toBeInstanceOf(MemberMcpConflictError);
  const connected = await store.save(tenantId, userId, serverId, { ...saveInput, version: 2 });
  expect(connected.credentialVersion).toBe(3);
  expect(state.audit.map(event => event.type)).toEqual([
    "member.mcp_credential.saved", "member.mcp_credential.removed", "member.mcp_credential.saved"
  ]);
});

test("hides a stale personal label and legacy URL secret after organization scope change", async () => {
  const { state, store } = setup();
  await store.save(tenantId, userId, serverId, saveInput);
  state.server.credential_scope = "organization";
  state.server.upstream_auth_type = "none";
  state.server.upstream_auth_name = null;
  state.server.upstream_url = "https://vendor.example/mcp?api_key=legacy-shared-secret";
  const organization = (await store.list(tenantId, userId))[0];
  expect(organization).toMatchObject({ status: "organization", accountLabel: null,
    upstreamUrl: null, authType: "none", authName: null, canConnect: false, hasCredential: true });
  expect(JSON.stringify(organization)).not.toContain("legacy-shared-secret");
  state.server.upstream_url = "https://vendor.example/mcp";
  const anonymous = (await store.list(tenantId, userId))[0];
  expect(anonymous).toMatchObject({ status: "no_auth", accountLabel: null,
    upstreamUrl: null, canConnect: false });
});

test("rejects invalid inputs before transaction or encryption", async () => {
  const { pool, store } = setup();
  for (const secret of ["short", "bad\nsecret", "x".repeat(8193)]) {
    await expect(store.save(tenantId, userId, serverId, { ...saveInput, secret }))
      .rejects.toBeInstanceOf(MemberMcpValidationError);
  }
  await expect(store.save(tenantId, userId, serverId, { ...saveInput, version: -1 }))
    .rejects.toBeInstanceOf(MemberMcpValidationError);
  await expect(store.save(tenantId, userId, serverId, { ...saveInput, accountLabel: "x".repeat(121) }))
    .rejects.toBeInstanceOf(MemberMcpValidationError);
  await expect(store.remove(tenantId, userId, serverId, -1)).rejects.toBeInstanceOf(MemberMcpValidationError);
  expect(pool.queries).toEqual([]);
});

test("reads the status of several servers in one transaction", async () => {
  const { pool, store, server } = setup();
  await store.save(tenantId, userId, serverId, saveInput);
  const missing = { ...server(), serverId: "removed-proxy" };
  const before = pool.queries.length;
  const statuses = await store.listStatuses(tenantId, userId, [server(), missing]);
  expect(statuses.get(serverId)).toEqual({ status: "connected", credentialVersion: 1, accountLabel: "My account" });
  expect(statuses.get("removed-proxy")).toMatchObject({ status: "unavailable" });
  expect(pool.queries.slice(before).filter(query => query.text.trim() === "BEGIN")).toHaveLength(1);
  expect(await store.listStatuses(tenantId, userId, [])).toEqual(new Map());
});

test("tells a member removal apart from a binding rotation", async () => {
  const { state, store, server } = setup();
  await store.save(tenantId, userId, serverId, saveInput);
  await store.remove(tenantId, userId, serverId, 1);
  state.server.credential_binding_id = "00000000-0000-4000-8000-000000000002";
  expect(await store.getStatus(tenantId, userId, server())).toEqual({
    status: "not_connected", credentialVersion: 2, accountLabel: null });
  expect((await store.list(tenantId, userId))[0]).toMatchObject({ status: "not_connected", hasCredential: false });

  // A rotation that revokes the secret keeps the old binding and the label.
  await store.save(tenantId, userId, serverId, { ...saveInput, version: 2 });
  const revoked = state.credentials.get(userId)!;
  revoked.secret_encrypted = null;
  revoked.version += 1;
  state.server.credential_binding_id = "00000000-0000-4000-8000-000000000003";
  expect(await store.getStatus(tenantId, userId, server())).toEqual({
    status: "reconnect_required", credentialVersion: 4, accountLabel: "My account" });
});

test("clears a secret for an old system binding when a read sees it", async () => {
  const { state, pool, store, server } = setup();
  state.server.tenant_id = "system";
  await store.save(tenantId, userId, serverId, saveInput);
  // The system server rotates. Its revoke cannot reach this tenant's row.
  state.server.credential_binding_id = "00000000-0000-4000-8000-000000000002";
  expect(await store.getRuntimeCredential(tenantId, userId, server())).toBeNull();
  expect(state.credentials.get(userId)).toMatchObject({
    secret_encrypted: null, version: 2, account_label: "My account", credential_binding_id: bindingId });
  const clears = () => pool.queries.filter(query =>
    query.text.includes("UPDATE member_mcp_credentials SET") && query.text.includes("secret_encrypted IS NOT NULL"));
  expect(clears()).toHaveLength(1);
  expect(clears()[0]?.values).toEqual([tenantId, userId, serverId, bindingId]);

  // listStatuses clears it too, and a cleared row is not written again.
  state.credentials.get(userId)!.secret_encrypted = "stale";
  expect(await store.getStatus(tenantId, userId, server())).toEqual({
    status: "reconnect_required", credentialVersion: 3, accountLabel: "My account" });
  expect(state.credentials.get(userId)?.secret_encrypted).toBeNull();
  await store.getStatus(tenantId, userId, server());
  expect(clears()).toHaveLength(2);
});
