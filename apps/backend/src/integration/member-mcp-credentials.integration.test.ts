import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { withTenantScope } from "../lib/db.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { MemberMcpAccessError, MemberMcpConflictError, MemberMcpCredentialStore,
  MemberMcpNotFoundError, MemberMcpValidationError } from "../services/member-mcp-credential-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const encryptionSecret = "member-mcp-integration-encryption-secret-32-chars";
const memberStore = () => new MemberMcpCredentialStore(appPool(), encryptionSecret);
const serverStore = () => new McpServerStore(appPool(), encryptionSecret);
async function setup() {
  const tenant = await seedTenant(), first = await seedUser(), second = await seedUser();
  await Promise.all([seedMembership(tenant, first), seedMembership(tenant, second)]);
  const projectId = `shared-${randomUUID()}`;
  await superuserPool().query("INSERT INTO projects (tenant_id,project_id,user_id,name) VALUES ($1,$2,$3,'Shared work')",
    [tenant, projectId, first]);
  await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'editor')",
    [tenant, projectId, second]);
  const serverId = `proxy-${randomUUID()}`;
  const server = await serverStore().createMcpServer(tenant, {
    serverId, serverName: "Vendor", description: "Shared project connector", transportKind: "http", mode: "proxy",
    routePath: `/mcp/${serverId}`, upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "header",
    upstreamAuthName: "X-API-Key", upstreamAuthSecret: null, credentialScope: "personal", enabled: true, createdBy: first
  });
  await serverStore().setMcpServerPublished(tenant, serverId, true);
  await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [serverId] });
  const current = await serverStore().getAdminMcpServer(tenant, serverId);
  if (!current) throw new Error("Missing test server");
  return { tenant, first, second, serverId, server: current, projectId, initial: server };
}

describe.skipIf(!adminDatabaseUrl())("member MCP credentials", () => {
  test("isolates two project members, encrypts secrets, and hides them from lists and audit", async () => {
    const { tenant, first, second, serverId, server } = await setup();
    const members = memberStore();
    expect((await members.list(tenant, first))[0]).toMatchObject({ serverId, status: "not_connected", canConnect: true });
    expect((await members.list(tenant, second))[0]).toMatchObject({ serverId, status: "not_connected" });
    const firstSaved = await members.save(tenant, first, serverId, {
      version: 0, serverVersion: server.version, secret: "first-secret", accountLabel: "First account" });
    expect(firstSaved).toMatchObject({ status: "connected", credentialVersion: 1, accountLabel: "First account", hasCredential: true });
    expect(JSON.stringify(firstSaved)).not.toContain("first-secret");
    await members.save(tenant, second, serverId, {
      version: 0, serverVersion: server.version, secret: "second-secret", accountLabel: "Second account" });
    expect((await members.getRuntimeCredential(tenant, first, server))?.auth).toEqual({
      type: "header", name: "X-API-Key", secret: "first-secret" });
    expect((await members.getRuntimeCredential(tenant, second, server))?.auth).toEqual({
      type: "header", name: "X-API-Key", secret: "second-secret" });
    expect((await members.list(tenant, first))[0].accountLabel).toBe("First account");
    expect((await members.list(tenant, second))[0].accountLabel).toBe("Second account");
    const stored = await superuserPool().query(
      "SELECT user_id,secret_encrypted FROM member_mcp_credentials WHERE tenant_id=$1 AND server_id=$2", [tenant, serverId]);
    expect(stored.rows).toHaveLength(2);
    expect(JSON.stringify(stored.rows)).not.toContain("first-secret");
    expect(JSON.stringify(stored.rows)).not.toContain("second-secret");
    const audit = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='member.mcp_credential.saved'", [tenant]);
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain("secret");
    expect(JSON.stringify(audit.rows)).not.toContain("account");
    await withTenantScope(appPool(), tenant, async client => {
      const ownerRows = await client.query("SELECT * FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2", [tenant, first]);
      expect(ownerRows.rows).toHaveLength(1);
    });
    const otherTenant = await seedTenant(), otherUser = await seedUser();
    await seedMembership(otherTenant, otherUser);
    await withTenantScope(appPool(), otherTenant, async client => {
      expect((await client.query("SELECT * FROM member_mcp_credentials WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
    });
    await expect(members.list(otherTenant, first)).rejects.toBeInstanceOf(MemberMcpAccessError);
  });

  test("endpoint change and change back require reconnect; display edits preserve binding", async () => {
    const { tenant, first, serverId, server } = await setup();
    const members = memberStore(), servers = serverStore();
    await members.save(tenant, first, serverId, {
      version: 0, serverVersion: server.version, secret: "bound-secret", accountLabel: null });
    const display = await servers.updateMcpServer(tenant, { serverId, serverName: "Renamed", description: "New description",
      transportKind: "http", mode: "proxy", routePath: server.routePath, enabled: true });
    expect(display?.credentialBindingId).toBe(server.credentialBindingId);
    expect((await members.getRuntimeCredential(tenant, first, display!))?.auth).toMatchObject({ secret: "bound-secret" });
    const changed = await servers.updateMcpServer(tenant, { serverId, serverName: "Renamed", description: "New description",
      transportKind: "http", mode: "proxy", routePath: server.routePath, upstreamUrl: "https://other.example/mcp", enabled: true });
    expect(changed?.credentialBindingId).not.toBe(server.credentialBindingId);
    expect(await members.getRuntimeCredential(tenant, first, changed!)).toBeNull();
    expect(await members.getStatus(tenant, first, changed!)).toMatchObject({ status: "reconnect_required", credentialVersion: 2 });
    const revoked = await superuserPool().query(
      "SELECT secret_encrypted, version FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3",
      [tenant, first, serverId]);
    expect(revoked.rows[0]).toEqual({ secret_encrypted: null, version: 2 });
    const restored = await servers.updateMcpServer(tenant, { serverId, serverName: "Renamed", description: "New description",
      transportKind: "http", mode: "proxy", routePath: server.routePath, upstreamUrl: server.upstreamUrl, enabled: true });
    expect(restored?.credentialBindingId).not.toBe(server.credentialBindingId);
    expect(await members.getRuntimeCredential(tenant, first, restored!)).toBeNull();
    await expect(members.save(tenant, first, serverId, { version: 2, serverVersion: server.version,
      secret: "new-secret", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpConflictError);
    const reconnected = await members.save(tenant, first, serverId, { version: 2, serverVersion: restored!.version,
      secret: "new-secret", accountLabel: null });
    expect(reconnected).toMatchObject({ status: "connected", credentialVersion: 3 });
    expect((await members.getRuntimeCredential(tenant, first, restored!))?.auth).toMatchObject({ secret: "new-secret" });
    expect(await members.getStatus(tenant, first, server)).toMatchObject({ status: "reconnect_required", credentialVersion: 3 });
  });

  test("revocation blocks runtime but permits tombstone removal and prevents stale save", async () => {
    const { tenant, first, second, serverId, server } = await setup();
    const members = memberStore();
    await members.save(tenant, first, serverId, { version: 0, serverVersion: server.version,
      secret: "secret-long", accountLabel: "Account" });
    await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [] });
    expect(await members.getRuntimeCredential(tenant, first, server)).toBeNull();
    expect((await members.list(tenant, first))[0]).toMatchObject({ status: "unavailable", canConnect: false,
      hasCredential: true, accountLabel: null });
    expect(await members.list(tenant, second)).toEqual([]);
    await expect(members.save(tenant, first, serverId, { version: 1, serverVersion: server.version,
      secret: "new-secret", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpNotFoundError);
    await members.remove(tenant, first, serverId, 1);
    const tombstone = await superuserPool().query("SELECT version,secret_encrypted,account_label FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3",
      [tenant, first, serverId]);
    expect(tombstone.rows[0]).toMatchObject({ version: 2, secret_encrypted: null, account_label: null });
    expect((await members.list(tenant, first))[0]).toMatchObject({ hasCredential: false, credentialVersion: 2 });
    await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [serverId] });
    await expect(members.save(tenant, first, serverId, { version: 1, serverVersion: server.version,
      secret: "stale-secret", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpConflictError);
    expect(await members.getRuntimeCredential(tenant, first, server)).toBeNull();
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenant, first]);
    expect((await superuserPool().query("SELECT * FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2", [tenant, first])).rows).toEqual([]);
  });

  test("rejects invalid secrets and rolls back a save when audit fails", async () => {
    const { tenant, first, serverId, server } = await setup();
    const members = memberStore();
    await expect(members.save(tenant, first, serverId, { version: 0, serverVersion: server.version,
      secret: "bad\nsecret", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpValidationError);
    await expect(members.save(tenant, first, serverId, { version: 0, serverVersion: server.version,
      secret: "short", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpValidationError);
    const auditFailure = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("audit failed"));
    try {
      await expect(members.save(tenant, first, serverId, { version: 0, serverVersion: server.version,
        secret: "valid-secret", accountLabel: null })).rejects.toThrow("audit failed");
    } finally { auditFailure.mockRestore(); }
    expect(await members.getStatus(tenant, first, server)).toMatchObject({ status: "not_connected", credentialVersion: 0 });
    expect((await superuserPool().query("SELECT * FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2", [tenant, first])).rows).toEqual([]);
  });

  test("accepts an approved inherited system proxy under tenant RLS", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const serverId = `system-proxy-${randomUUID()}`;
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers
       (tenant_id,server_id,server_name,description,mode,route_path,upstream_url,
        upstream_auth_type,upstream_auth_name,credential_scope,config_hash,enabled,is_published,created_by)
       VALUES ('system',$1,'Inherited proxy',NULL,'proxy',$2,'https://vendor.example/mcp',
        'header','X-API-Key','personal','seed',true,true,$3)`, [serverId, `/mcp/${serverId}`, user]);
    await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [serverId] });
    const record = await serverStore().getAdminMcpServer(tenant, serverId);
    if (!record) throw new Error("Missing system proxy");
    const members = memberStore();
    const saved = await members.save(tenant, user, serverId, { version: 0, serverVersion: record.version,
      secret: "system-personal-secret", accountLabel: null });
    expect(saved).toMatchObject({ status: "connected", credentialVersion: 1 });
    expect((await members.getRuntimeCredential(tenant, user, record))?.auth).toMatchObject({ secret: "system-personal-secret" });
    // A system binding rotation cannot revoke this tenant's row. The next
    // read clears the old secret under the tenant's own RLS scope.
    await superuserPool().query(
      "UPDATE admin_mcp_servers SET credential_binding_id=gen_random_uuid() WHERE tenant_id='system' AND server_id=$1",
      [serverId]);
    const rotated = await serverStore().getAdminMcpServer(tenant, serverId);
    expect(await members.getStatus(tenant, user, rotated!)).toMatchObject({
      status: "reconnect_required", credentialVersion: 2 });
    const cleared = await superuserPool().query(
      "SELECT version,secret_encrypted FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3",
      [tenant, user, serverId]);
    expect(cleared.rows[0]).toMatchObject({ version: 2, secret_encrypted: null });
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers
       (tenant_id,server_id,server_name,description,mode,route_path,upstream_url,
        upstream_auth_type,upstream_auth_name,credential_scope,config_hash,enabled,is_published,created_by)
       VALUES ($1,$2,'Disabled override',NULL,'proxy',$3,'https://vendor.example/mcp',
        'header','X-API-Key','personal','override',false,true,$4)`, [tenant, serverId, `/mcp/${serverId}`, user]);
    expect(await members.getRuntimeCredential(tenant, user, record)).toBeNull();
    expect((await members.list(tenant, user))[0]).toMatchObject({ status: "unavailable", canConnect: false });
  });

  test("never returns a legacy organization URL query secret in member connections", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const serverId = `legacy-${randomUUID()}`;
    const legacySecret = "legacy-shared-api-key";
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers
       (tenant_id,server_id,server_name,description,mode,route_path,upstream_url,
        upstream_auth_type,config_hash,enabled,is_published,created_by)
       VALUES ($1,$2,'Legacy shared connector',NULL,'proxy',$3,$4,'none','legacy',true,true,$5)`,
      [tenant, serverId, `/mcp/${serverId}`, `https://vendor.example/mcp?api_key=${legacySecret}`, user]);
    await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [serverId] });
    const listed = await memberStore().list(tenant, user);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ serverId, status: "organization", upstreamUrl: null,
      authType: "none", authName: null, canConnect: false });
    expect(JSON.stringify(listed)).not.toContain(legacySecret);
  });

  test("switching auth scope clears shared secrets and requires a fresh one to switch back", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const serverId = `shared-${randomUUID()}`;
    const servers = serverStore();
    const base = { serverId, serverName: "Shared", description: null, transportKind: "http" as const,
      mode: "proxy" as const, routePath: `/mcp/${serverId}`, upstreamUrl: "https://vendor.example/mcp",
      upstreamAuthType: "header" as const, upstreamAuthName: "X-API-Key", enabled: true };
    const shared = await servers.createMcpServer(tenant, { ...base, upstreamAuthSecret: "old-shared-secret", createdBy: user });
    expect(shared).toMatchObject({ credentialScope: "organization", upstreamAuthConfigured: true });
    const personal = await servers.updateMcpServer(tenant, { ...base, credentialScope: "personal", upstreamAuthSecret: null });
    expect(personal?.credentialBindingId).not.toBe(shared.credentialBindingId);
    expect(personal).toMatchObject({ credentialScope: "personal", upstreamAuthConfigured: false });
    expect((await servers.getMcpServer(tenant, serverId))?.upstreamAuth).toBeNull();
    await servers.setMcpServerPublished(tenant, serverId, true);
    await new TenantSettingsStore(appPool()).upsert(tenant, { enabledMcpServerIds: [serverId] });
    const personalCurrent = await servers.getAdminMcpServer(tenant, serverId);
    if (!personalCurrent) throw new Error("Missing personal proxy");
    await memberStore().save(tenant, user, serverId, { version: 0, serverVersion: personalCurrent.version,
      secret: "member-secret", accountLabel: "Member account" });
    const stored = await superuserPool().query(
      "SELECT upstream_auth_secret_encrypted FROM admin_mcp_servers WHERE tenant_id=$1 AND server_id=$2", [tenant, serverId]);
    expect(stored.rows[0].upstream_auth_secret_encrypted).toBeNull();
    await expect(servers.updateMcpServer(tenant, { ...base, credentialScope: "organization" }))
      .rejects.toThrow("requires a secret");
    const restored = await servers.updateMcpServer(tenant, { ...base, credentialScope: "organization",
      upstreamAuthSecret: "new-shared-secret" });
    expect(restored?.credentialBindingId).not.toBe(shared.credentialBindingId);
    expect((await servers.getMcpServer(tenant, serverId))?.upstreamAuth).toMatchObject({ secret: "new-shared-secret" });
    expect(await memberStore().getStatus(tenant, user, restored!)).toMatchObject({
      status: "organization", accountLabel: null, credentialVersion: 2 });
    const member = await superuserPool().query(
      "SELECT secret_encrypted FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3",
      [tenant, user, serverId]);
    expect(member.rows[0].secret_encrypted).toBeNull();
    expect((await memberStore().list(tenant, user))[0]).toMatchObject({ status: "organization", accountLabel: null });
  });

  test("serializes first saves and checks server version", async () => {
    const { tenant, first, serverId, server } = await setup();
    const members = memberStore();
    const attempts = await Promise.allSettled([
      members.save(tenant, first, serverId, { version: 0, serverVersion: server.version, secret: "first-secret", accountLabel: null }),
      members.save(tenant, first, serverId, { version: 0, serverVersion: server.version, secret: "second-secret", accountLabel: null })
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected" && result.reason instanceof MemberMcpConflictError)).toHaveLength(1);
    expect((await members.getStatus(tenant, first, server)).credentialVersion).toBe(1);
    await expect(members.save(tenant, first, serverId, { version: 1, serverVersion: server.version - 1,
      secret: "third-secret", accountLabel: null })).rejects.toBeInstanceOf(MemberMcpConflictError);
  });
});
