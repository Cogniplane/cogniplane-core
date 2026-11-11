// A personal connection acts as its owner. A session that a stolen access
// token opened can attach the attacker's own account or secret. Each
// connection keeps the security version of the session that saved it
// (migration 083). After a security change of the owner's local account, the
// read for use does not return the connection (it is suspended). The owner's
// read shows it as suspended. Only a confirm from a current session restores
// it. WorkOS owners are not compared.
//
// These tests run the production store SQL and LocalAccountService against
// real Postgres under RLS. The Microsoft store is in the private overlay; its
// own integration test covers it.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { McpConnectionSchema, SessionCapabilitiesSchema } from "@cogniplane/shared-types";

import { PasswordHasher } from "../lib/password-hash.js";
import { memberMcpStatuses } from "../routes/member-mcp-status.js";
import { OwnerSecurityVersionChangedError } from "../services/auth/security-change.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { GithubConnectionStore } from "../services/integrations/github/github-connection-store.js";
import { NotionConnectionStore } from "../services/integrations/notion/notion-connection-store.js";
import { JiraConnectionStore } from "../services/integrations/pipedream/jira-connection-store.js";
import { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const META: RequestMeta = { ipAddress: "203.0.113.9", userAgent: "integration" };
const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";
const ENCRYPTION_SECRET = "connection-security-integration-secret-32-chars";
const SITE = "11111111-2222-4333-8444-555555555555";
const MIGRATION_083 = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations/083_connection_owner_security_version.sql");

type Owner = { tenantId: string; userId: string; securityVersion: number };

// No runtimes run in these tests: the stop after the commit has nothing to stop.
function accounts() {
  return new LocalAccountService({
    afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(),
    hasher: new PasswordHasher(4), frontendOrigin: ORIGIN
  });
}

/** An active local owner, signed in at security version 1. */
async function activeLocalOwner(): Promise<Owner> {
  const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
    tenantName: "Connections", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
  });
  const session = await accounts().redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
  expect(session.securityVersion).toBe(1);
  return { tenantId: boot.tenantId, userId: boot.userId, securityVersion: session.securityVersion };
}

/** "Sign out everywhere": the production path that increments the version. Returns the new version. */
async function signOutEverywhere(owner: Owner): Promise<number> {
  await accounts().revokeSessions(owner.tenantId, owner.userId, owner.userId, META);
  const { rows } = await superuserPool().query<{ security_version: number }>(
    "SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2", [owner.tenantId, owner.userId]);
  expect(rows[0]!.security_version).toBe(owner.securityVersion + 1);
  return rows[0]!.security_version;
}

async function auditPayloads(tenantId: string, eventType: string) {
  const { rows } = await superuserPool().query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = $2 ORDER BY id", [tenantId, eventType]);
  return rows.map((row) => row.payload);
}

// The MCP contracts from before this change. A client built from them must
// still read every response (deploy order is free).
const STATUS_BEFORE = z.enum(["not_connected", "connected", "reconnect_required", "organization", "no_auth", "unavailable"]);
const McpConnectionBeforeSchema = z.object({
  status: STATUS_BEFORE, credentialVersion: z.number().int().nonnegative(), accountLabel: z.string().nullable(),
  serverId: z.string(), serverName: z.string(), description: z.string().nullable(), upstreamUrl: z.string().nullable(),
  authType: z.enum(["none", "bearer", "header", "query"]), authName: z.string().nullable(),
  credentialScope: z.enum(["organization", "personal"]), serverVersion: z.number().int().nonnegative(),
  canConnect: z.boolean(), hasCredential: z.boolean().default(false)
});
const CapabilityOptionBeforeSchema = z.object({
  connectionStatus: STATUS_BEFORE.optional(), accountLabel: z.string().nullable().optional()
});

/** A WorkOS member: no local identity. */
async function workosMember(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId, "member");
  return { tenantId, userId };
}

function oauthFields(githubUserId: string) {
  return {
    githubUserId, githubLogin: `login-${githubUserId}`, githubName: null, githubEmail: null, githubAvatarUrl: null,
    tokenType: "bearer", grantedScopes: ["repo"], accessTokenEncrypted: "encrypted-access", accessTokenExpiresAt: null,
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null
  };
}

function notionFields(notionUserId: string, notionWorkspaceId: string | null) {
  return {
    notionUserId, notionWorkspaceId, notionWorkspaceName: "Workspace", notionWorkspaceIcon: null, notionBotId: null,
    notionOwnerEmail: `${notionUserId}@example.test` as string | null, notionOwnerName: null, tokenType: "bearer", grantedScopes: [],
    accessTokenEncrypted: "encrypted-access", accessTokenExpiresAt: null, refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null, tokenLastRefreshedAt: null
  };
}

describe.skipIf(!adminDatabaseUrl())("personal connections after a security change of the owner", () => {
  test("GitHub: suspended for use, shown to the owner, and restored only by a current session", async () => {
    const owner = await activeLocalOwner();
    const store = new GithubConnectionStore(appPool());
    await store.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...oauthFields("attacker"), ownerSecurityVersion: 1 });
    expect((await store.get(owner.tenantId, owner.userId))?.githubUserId).toBe("attacker");
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ suspended: false });

    const current = await signOutEverywhere(owner);
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ githubUserId: "attacker", suspended: true });
    // A refresh that races the security change stores nothing on a suspended connection.
    await superuserPool().query(
      "UPDATE user_github_connections SET refresh_token_encrypted = 'r1' WHERE tenant_id = $1", [owner.tenantId]);
    const refresh = (expectedRefreshTokenEncrypted: string, refreshTokenEncrypted: string) => store.updateRefreshedToken({
      tenantId: owner.tenantId, userId: owner.userId, expectedGithubUserId: "attacker", expectedRefreshTokenEncrypted,
      tokenType: "bearer", grantedScopes: ["repo"], accessTokenEncrypted: "a2", accessTokenExpiresAt: null,
      refreshTokenEncrypted, refreshTokenExpiresAt: null
    });
    expect(await refresh("r1", "r2")).toBeNull();
    expect((await store.getForOwner(owner.tenantId, owner.userId))?.accessTokenEncrypted).toBe("encrypted-access");
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();

    // Another account, or a session from before the change, does not restore it.
    expect(await store.confirm(owner.tenantId, owner.userId, "someone-else", current)).toBeNull();
    expect(await store.confirm(owner.tenantId, owner.userId, "attacker", owner.securityVersion)).toMatchObject({ suspended: true });
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await auditPayloads(owner.tenantId, "user.github.confirmed")).toEqual([]);

    // The confirm writes its audit event in the same transaction.
    expect(await store.confirm(owner.tenantId, owner.userId, "attacker", current)).toMatchObject({ suspended: false });
    expect((await store.get(owner.tenantId, owner.userId))?.githubUserId).toBe("attacker");
    expect(await auditPayloads(owner.tenantId, "user.github.confirmed"))
      .toEqual([{ githubLogin: "login-attacker", githubUserId: "attacker", ownerSecurityVersion: current }]);
    // Once confirmed, a refresh stores the new tokens and keeps the version.
    expect(await refresh("r1", "r2")).toMatchObject({ accessTokenEncrypted: "a2" });
    expect(await store.get(owner.tenantId, owner.userId)).not.toBeNull();

    // A reconnect from a current session stores its version, so it is not suspended.
    await signOutEverywhere({ ...owner, securityVersion: current });
    await store.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...oauthFields("mine"), ownerSecurityVersion: current + 1 });
    expect((await store.get(owner.tenantId, owner.userId))?.githubUserId).toBe("mine");
  });

  test("Notion: suspended for use, shown to the owner, and restored only by a current session", async () => {
    const owner = await activeLocalOwner();
    const store = new NotionConnectionStore(appPool());
    await store.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...notionFields("n-1", "ws-1"), ownerSecurityVersion: 1 });
    expect(await store.get(owner.tenantId, owner.userId)).not.toBeNull();

    const current = await signOutEverywhere(owner);
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ notionUserId: "n-1", suspended: true });

    const account = { notionUserId: "n-1", notionWorkspaceId: "ws-1" };
    expect(await store.confirm(owner.tenantId, owner.userId, { ...account, notionWorkspaceId: "ws-2" }, current)).toBeNull();
    expect(await store.confirm(owner.tenantId, owner.userId, account, owner.securityVersion)).toMatchObject({ suspended: true });
    expect(await auditPayloads(owner.tenantId, "user.notion.confirmed")).toEqual([]);
    expect(await store.confirm(owner.tenantId, owner.userId, account, current)).toMatchObject({ suspended: false });
    expect((await store.get(owner.tenantId, owner.userId))?.notionUserId).toBe("n-1");
    expect(await auditPayloads(owner.tenantId, "user.notion.confirmed"))
      .toEqual([{ notionUserId: "n-1", notionWorkspaceId: "ws-1", ownerSecurityVersion: current }]);

    // Without an owner email that Notion attested, there is no confirm.
    await store.upsert({ tenantId: owner.tenantId, userId: owner.userId,
      ...notionFields("n-no-email", "ws-x"), notionOwnerEmail: null, ownerSecurityVersion: current });
    const later = await signOutEverywhere({ ...owner, securityVersion: current });
    expect(await store.confirm(owner.tenantId, owner.userId, { notionUserId: "n-no-email", notionWorkspaceId: "ws-x" }, later))
      .toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ notionOwnerEmail: null, suspended: true });
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();

    // The workspace check treats NULL as a value.
    await store.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...notionFields("n-2", null), ownerSecurityVersion: later });
    const next = await signOutEverywhere({ ...owner, securityVersion: later });
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await store.confirm(owner.tenantId, owner.userId, { notionUserId: "n-2", notionWorkspaceId: null }, next))
      .toMatchObject({ suspended: false });
  });

  test("Jira: a site selection is suspended for use, has no confirm, and only a new selection restores it", async () => {
    const owner = await activeLocalOwner();
    const store = new JiraConnectionStore(appPool());
    const identity = await store.bindIdentity(owner.tenantId, owner.userId,
      { projectId: "proj_it", environment: "development" }, (n) => `cp1_it_${n}`, true);
    if (!identity) throw new Error("No Jira identity");
    await store.upsert({
      tenantId: owner.tenantId, userId: owner.userId, externalUserId: identity.externalUserId, accountId: "apn_attacker",
      accountName: "attacker@example.test", cloudId: SITE, siteName: "Acme", siteUrl: "https://acme.atlassian.net",
      ownerSecurityVersion: 1
    }, identity);
    expect((await store.get(owner.tenantId, owner.userId))?.accountId).toBe("apn_attacker");

    const current = await signOutEverywhere(owner);
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ accountId: "apn_attacker", suspended: true });

    // There is no confirm: the account ID is opaque and the name proves nothing.
    expect("confirm" in store).toBe(false);
    // A selection from a current session restores it.
    await store.upsert({
      tenantId: owner.tenantId, userId: owner.userId, externalUserId: identity.externalUserId, accountId: "apn_mine",
      accountName: null, cloudId: SITE, siteName: "Acme", siteUrl: "https://acme.atlassian.net", ownerSecurityVersion: current
    }, identity);
    expect((await store.get(owner.tenantId, owner.userId))?.accountId).toBe("apn_mine");

    // Disconnect still removes a suspended connection.
    await signOutEverywhere({ ...owner, securityVersion: current });
    expect(await store.retire(owner.tenantId, owner.userId, "user_disconnect", null)).not.toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toBeNull();
  });

  test("MCP credentials: a suspended credential is not used, shows as reconnect_required, and only a new secret restores it", async () => {
    const owner = await activeLocalOwner();
    const servers = new McpServerStore(appPool(), ENCRYPTION_SECRET);
    const serverId = `proxy-${randomUUID()}`;
    await servers.createMcpServer(owner.tenantId, {
      serverId, serverName: "Notes", description: null, transportKind: "http", mode: "proxy",
      routePath: `/mcp/${serverId}`, upstreamUrl: "https://notes.example/mcp", upstreamAuthType: "bearer",
      upstreamAuthName: null, upstreamAuthSecret: null, credentialScope: "personal", enabled: true, createdBy: owner.userId
    });
    await servers.setMcpServerPublished(owner.tenantId, serverId, true);
    await new TenantSettingsStore(appPool()).upsert(owner.tenantId, { enabledMcpServerIds: [serverId] });
    const server = await servers.getAdminMcpServer(owner.tenantId, serverId);
    if (!server) throw new Error("Missing test server");
    const members = new MemberMcpCredentialStore(appPool(), ENCRYPTION_SECRET);
    // The attacker keeps the member's label, so the label proves nothing.
    const saved = await members.save(owner.tenantId, owner.userId, serverId,
      { version: 0, serverVersion: server.version, secret: "attacker-secret", accountLabel: "Work" }, 1);
    expect(saved).toMatchObject({ status: "connected", credentialVersion: 1, accountLabel: "Work" });
    expect(saved.suspended).toBeUndefined();
    expect((await members.getRuntimeCredential(owner.tenantId, owner.userId, server))?.auth)
      .toEqual({ type: "bearer", secret: "attacker-secret" });

    const current = await signOutEverywhere(owner);
    expect(await members.getRuntimeCredential(owner.tenantId, owner.userId, server)).toBeNull();
    const listed = (await members.list(owner.tenantId, owner.userId)).find((item) => item.serverId === serverId);
    // The status stays in the enum that older clients know; the flag is additive.
    // The saver's label is not sent.
    expect(listed).toMatchObject({
      status: "reconnect_required", suspended: true, credentialVersion: 1, accountLabel: null, hasCredential: true
    });
    expect(await members.getStatus(owner.tenantId, owner.userId, server))
      .toEqual({ status: "reconnect_required", suspended: true, credentialVersion: 1, accountLabel: null });
    // There is no confirm for MCP credentials.
    expect("confirm" in members).toBe(false);

    // Both the current and the pre-change contracts read the responses.
    expect(McpConnectionSchema.parse(listed)).toMatchObject({ status: "reconnect_required", suspended: true });
    expect(McpConnectionBeforeSchema.parse(listed)).toMatchObject({ status: "reconnect_required", accountLabel: null });
    const option = (await memberMcpStatuses(members, owner.tenantId, owner.userId)).get(serverId);
    expect(option).toEqual({ connectionStatus: "reconnect_required", accountLabel: null, connectionSuspended: true });
    expect(CapabilityOptionBeforeSchema.parse(option)).toEqual({ connectionStatus: "reconnect_required", accountLabel: null });
    expect(SessionCapabilitiesSchema.shape.connectors.element.parse({ id: serverId, name: "Notes", description: "", ...option }))
      .toMatchObject({ connectionStatus: "reconnect_required", connectionSuspended: true });

    // A new secret from a current session stores that session's version.
    expect(await members.save(owner.tenantId, owner.userId, serverId,
      { version: 1, serverVersion: server.version, secret: "my-own-secret", accountLabel: null }, current))
      .toMatchObject({ status: "connected", credentialVersion: 2 });
    expect((await members.getRuntimeCredential(owner.tenantId, owner.userId, server))?.auth)
      .toEqual({ type: "bearer", secret: "my-own-secret" });
    // Removal works on a suspended credential.
    await signOutEverywhere({ ...owner, securityVersion: current });
    await members.remove(owner.tenantId, owner.userId, serverId, 2);
    expect((await members.list(owner.tenantId, owner.userId)).find((item) => item.serverId === serverId))
      .toMatchObject({ status: "not_connected", hasCredential: false });
  });

  test("an OAuth callback write is bound to the owner's current version", async () => {
    const owner = await activeLocalOwner();
    const github = new GithubConnectionStore(appPool());
    const notion = new NotionConnectionStore(appPool());
    // The owner's own connections, from a session at the current version.
    const current = await signOutEverywhere(owner);
    await github.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...oauthFields("mine"), ownerSecurityVersion: current });
    await notion.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...notionFields("n-mine", "ws"), ownerSecurityVersion: current });

    // A callback from an authorization that started before the change, or with no version.
    for (const startedAt of [owner.securityVersion, null]) {
      await expect(github.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...oauthFields("attacker"), ownerSecurityVersion: startedAt }))
        .rejects.toBeInstanceOf(OwnerSecurityVersionChangedError);
      await expect(notion.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...notionFields("n-attacker", "ws-a"), ownerSecurityVersion: startedAt }))
        .rejects.toBeInstanceOf(OwnerSecurityVersionChangedError);
    }
    // Nothing was written: the owner's connections stay, usable.
    expect((await github.get(owner.tenantId, owner.userId))?.githubUserId).toBe("mine");
    expect((await notion.get(owner.tenantId, owner.userId))?.notionUserId).toBe("n-mine");

    // A WorkOS member has no version: only NULL passes.
    const member = await workosMember();
    await expect(github.upsert({ tenantId: member.tenantId, userId: member.userId, ...oauthFields("w"), ownerSecurityVersion: 1 }))
      .rejects.toBeInstanceOf(OwnerSecurityVersionChangedError);
  });

  test("a WorkOS owner has no security version: connections without one stay usable", async () => {
    const member = await workosMember();
    const github = new GithubConnectionStore(appPool());
    await github.upsert({ tenantId: member.tenantId, userId: member.userId, ...oauthFields("w-1"), ownerSecurityVersion: null });
    expect((await github.get(member.tenantId, member.userId))?.githubUserId).toBe("w-1");
    expect(await github.getForOwner(member.tenantId, member.userId)).toMatchObject({ suspended: false });
    const notion = new NotionConnectionStore(appPool());
    await notion.upsert({ tenantId: member.tenantId, userId: member.userId, ...notionFields("w-n", null), ownerSecurityVersion: null });
    expect(await notion.get(member.tenantId, member.userId)).not.toBeNull();
  });

  test("a local owner's connection with no stored version is suspended", async () => {
    const owner = await activeLocalOwner();
    const github = new GithubConnectionStore(appPool());
    await github.upsert({ tenantId: owner.tenantId, userId: owner.userId, ...oauthFields("x"), ownerSecurityVersion: 1 });
    // As migration 083 leaves a connection without evidence of a save after the last change.
    await superuserPool().query(
      "UPDATE user_github_connections SET owner_security_version = NULL WHERE tenant_id = $1", [owner.tenantId]);
    expect(await github.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await github.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ suspended: true });
  });
});

describe.skipIf(!adminDatabaseUrl())("migration 083: connection owner security version", () => {
  // A database that applied the 081 file must run 083 without an error and
  // keep the versions that the backend stored since.
  test("runs again on a database that applied the earlier 081 file", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 82);
      const boot = await bootstrapLocalTenant(db, ORIGIN, {
        tenantName: "Applied 081", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
      });
      await db.query(
        `UPDATE local_identities SET security_version = 3, updated_at = NOW() - INTERVAL '1 day'
         WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, boot.userId]);
      // Connected after the change, so the backfill alone would store 3.
      await db.query(
        `INSERT INTO user_github_connections (tenant_id, user_id, github_user_id, github_login, access_token_encrypted, created_at, updated_at)
         VALUES ($1, $2, 'gh', 'gh', 'enc', NOW() - INTERVAL '1 hour', NOW())`, [boot.tenantId, boot.userId]);
      const sql = readFileSync(MIGRATION_083, "utf8");
      await db.query(sql);
      // The backend then stored another version (a confirm or a reconnect).
      await db.query("UPDATE user_github_connections SET owner_security_version = 7 WHERE tenant_id = $1", [boot.tenantId]);

      await migrate((file) => Number.parseInt(file, 10) === 83);
      const { rows } = await db.query<{ v: number | null }>(
        "SELECT owner_security_version AS v FROM user_github_connections WHERE tenant_id = $1", [boot.tenantId]);
      expect(rows).toEqual([{ v: 7 }]);
    });
  });

  test("only connections saved after the owner's last security change stay usable", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 82);

      // Local owners whose last security change was one day ago, at version 3.
      const localOwner = async () => {
        const boot = await bootstrapLocalTenant(db, ORIGIN, {
          tenantName: "Before 083", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
        });
        await db.query(
          `UPDATE local_identities SET security_version = 3, updated_at = NOW() - INTERVAL '1 day'
           WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, boot.userId]);
        return { tenantId: boot.tenantId, userId: boot.userId };
      };
      // A WorkOS member in another tenant.
      const workos = { tenantId: randomUUID(), userId: randomUUID() };
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'WorkOS', $1)", [workos.tenantId]);
      await db.query("INSERT INTO users (user_id, email) VALUES ($1, $2)", [workos.userId, `${workos.userId}@example.test`]);
      await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')",
        [workos.tenantId, workos.userId]);

      type Person = { tenantId: string; userId: string };
      // `created` and `updated` are offsets from now, as SQL intervals.
      const github = (who: Person, created: string, updated: string) => db.query(
        `INSERT INTO user_github_connections (tenant_id, user_id, github_user_id, github_login, access_token_encrypted, created_at, updated_at)
         VALUES ($1, $2, 'gh', 'gh', 'enc', NOW() - $3::interval, NOW() - $4::interval)`, [who.tenantId, who.userId, created, updated]);
      const notion = (who: Person, created: string) => db.query(
        `INSERT INTO user_notion_connections (tenant_id, user_id, notion_user_id, access_token_encrypted, created_at, updated_at)
         VALUES ($1, $2, 'n', 'enc', NOW() - $3::interval, NOW())`, [who.tenantId, who.userId, created]);
      const microsoft = (who: Person, created: string) => db.query(
        `INSERT INTO user_microsoft_connections (tenant_id, user_id, microsoft_user_id, access_token_encrypted, created_at, updated_at)
         VALUES ($1, $2, 'ms', 'enc', NOW() - $3::interval, NOW())`, [who.tenantId, who.userId, created]);
      const jira = (who: Person, created: string) => db.query(
        `INSERT INTO user_jira_connections (tenant_id, user_id, pipedream_external_user_id, pipedream_account_id,
           jira_cloud_id, jira_site_name, jira_site_url, created_at, updated_at)
         VALUES ($1, $2, 'cp1_x', 'apn_x', $3, 'Acme', 'https://acme.atlassian.net', NOW() - $4::interval, NOW())`,
        [who.tenantId, who.userId, SITE, created]);
      const mcp = (who: Person, serverId: string, updated: string, secret: string | null) => db.query(
        `INSERT INTO member_mcp_credentials (tenant_id, user_id, server_id, credential_binding_id, secret_encrypted, created_at, updated_at)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, NOW() - INTERVAL '3 days', NOW() - $5::interval)`,
        [who.tenantId, who.userId, serverId, secret, updated]);
      const event = (who: Person, type: string, age: string) => db.query(
        `INSERT INTO audit_events (tenant_id, user_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, '{}'::jsonb, NOW() - $4::interval)`, [who.tenantId, who.userId, type, age]);

      // GitHub. Connected before the change and used after it (each use and
      // each refresh sets updated_at, which is not a save).
      const ghUsedAfter = await localOwner(); await github(ghUsedAfter, "2 days", "1 minute");
      // Connected before the change, reconnected after it (the audit event).
      const ghReconnected = await localOwner(); await github(ghReconnected, "2 days", "2 days");
      await event(ghReconnected, "user.github.connected", "1 hour");
      // Connected after the change.
      const ghCreatedAfter = await localOwner(); await github(ghCreatedAfter, "1 hour", "1 hour");
      // A callback 5 minutes after the change can still carry a revoked session's state.
      const ghInOAuthMargin = await localOwner(); await github(ghInOAuthMargin, "86100 seconds", "86100 seconds");
      // An event of another member does not count.
      const ghOtherEvent = await localOwner(); await github(ghOtherEvent, "2 days", "2 days");
      await event({ tenantId: ghOtherEvent.tenantId, userId: workos.userId }, "user.github.connected", "1 hour");
      // Another event type does not count.
      const ghOtherType = await localOwner(); await github(ghOtherType, "2 days", "2 days");
      await event(ghOtherType, "user.github.repositories_updated", "1 hour");
      await github(workos, "2 days", "2 days");

      const notionBefore = await localOwner(); await notion(notionBefore, "2 days");
      const notionReconnected = await localOwner(); await notion(notionReconnected, "2 days");
      await event(notionReconnected, "user.notion.connected", "1 hour");
      const msBefore = await localOwner(); await microsoft(msBefore, "2 days");
      const msAfter = await localOwner(); await microsoft(msAfter, "1 hour");
      const msReconnected = await localOwner(); await microsoft(msReconnected, "2 days");
      await event(msReconnected, "user.microsoft.connected", "1 hour");

      // Jira: a site selection is a session request, so the margin is one minute.
      const jiraBefore = await localOwner(); await jira(jiraBefore, "2 days");
      const jiraAfter = await localOwner(); await jira(jiraAfter, "86100 seconds");
      const jiraInMargin = await localOwner(); await jira(jiraInMargin, "86370 seconds");
      const jiraReselected = await localOwner(); await jira(jiraReselected, "2 days");
      await event(jiraReselected, "user.jira.connected", "1 hour");

      // MCP: on a row with a secret, updated_at is the last save.
      const mcpOwner = await localOwner();
      await mcp(mcpOwner, "saved-before", "2 days", "enc");
      await mcp(mcpOwner, "saved-after", "1 hour", "enc");
      await mcp(mcpOwner, "removed-after", "1 hour", null);
      await mcp(mcpOwner, "in-margin", "86370 seconds", "enc");
      await mcp(workos, "workos", "2 days", "enc");

      await migrate((file) => Number.parseInt(file, 10) === 83);

      const versionOf = async (table: string, who: Person, extra = "") => (await db.query<{ v: number | null }>(
        `SELECT owner_security_version AS v FROM ${table} WHERE tenant_id = $1 AND user_id = $2 ${extra}`,
        [who.tenantId, who.userId])).rows[0]!.v;
      expect({
        ghUsedAfter: await versionOf("user_github_connections", ghUsedAfter),
        ghReconnected: await versionOf("user_github_connections", ghReconnected),
        ghCreatedAfter: await versionOf("user_github_connections", ghCreatedAfter),
        ghInOAuthMargin: await versionOf("user_github_connections", ghInOAuthMargin),
        ghOtherEvent: await versionOf("user_github_connections", ghOtherEvent),
        ghOtherType: await versionOf("user_github_connections", ghOtherType),
        ghWorkos: await versionOf("user_github_connections", workos)
      }).toEqual({
        ghUsedAfter: null, ghReconnected: 3, ghCreatedAfter: 3, ghInOAuthMargin: null,
        ghOtherEvent: null, ghOtherType: null, ghWorkos: null
      });
      expect({
        notionBefore: await versionOf("user_notion_connections", notionBefore),
        notionReconnected: await versionOf("user_notion_connections", notionReconnected),
        msBefore: await versionOf("user_microsoft_connections", msBefore),
        msAfter: await versionOf("user_microsoft_connections", msAfter),
        msReconnected: await versionOf("user_microsoft_connections", msReconnected)
      }).toEqual({ notionBefore: null, notionReconnected: 3, msBefore: null, msAfter: 3, msReconnected: 3 });
      expect({
        jiraBefore: await versionOf("user_jira_connections", jiraBefore),
        jiraAfter: await versionOf("user_jira_connections", jiraAfter),
        jiraInMargin: await versionOf("user_jira_connections", jiraInMargin),
        jiraReselected: await versionOf("user_jira_connections", jiraReselected)
      }).toEqual({ jiraBefore: null, jiraAfter: 3, jiraInMargin: null, jiraReselected: 3 });
      expect({
        savedBefore: await versionOf("member_mcp_credentials", mcpOwner, "AND server_id = 'saved-before'"),
        savedAfter: await versionOf("member_mcp_credentials", mcpOwner, "AND server_id = 'saved-after'"),
        removedAfter: await versionOf("member_mcp_credentials", mcpOwner, "AND server_id = 'removed-after'"),
        inMargin: await versionOf("member_mcp_credentials", mcpOwner, "AND server_id = 'in-margin'"),
        workos: await versionOf("member_mcp_credentials", workos)
      }).toEqual({ savedBefore: null, savedAfter: 3, removedAfter: null, inMargin: null, workos: null });

      // The production read: connections with no version of a local owner
      // are suspended; the WorkOS connection and the kept ones are not.
      const githubStore = new GithubConnectionStore(db);
      expect(await githubStore.get(ghUsedAfter.tenantId, ghUsedAfter.userId)).toBeNull();
      expect(await githubStore.get(ghReconnected.tenantId, ghReconnected.userId)).not.toBeNull();
      expect(await githubStore.get(workos.tenantId, workos.userId)).not.toBeNull();
    });
  });
});
