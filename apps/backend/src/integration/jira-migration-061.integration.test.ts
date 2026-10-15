// Migration 061 backfill of migration 060 data, in its own database: the
// suite database already has 061 applied. A member removed before 061 keeps a
// pending cleanup for the generation 0 external ID. When the member comes
// back, the new authorization must use another ID, so that the old cleanup
// cannot delete the new account.

import { describe, expect, test } from "vitest";

import { JiraConnectionService } from "../services/integrations/pipedream/jira-connection-service.js";
import { JiraConnectionStore } from "../services/integrations/pipedream/jira-connection-store.js";
import type { PipedreamAccount, PipedreamConnectClient } from "../services/integrations/pipedream/pipedream-client.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl } from "./support/database.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const SITE = "11111111-2222-4333-8444-555555555555";

describe.skipIf(!adminDatabaseUrl())("Jira migration 061", () => {
  test("a member removed before 061 gets a new external ID when added again", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 60);

      const store = new JiraConnectionStore(db);
      let accounts: PipedreamAccount[] = [];
      const client = {
        async createConnectToken() {
          return { connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok", expiresAt: "x" };
        },
        async listAccounts(input: { externalUserId: string }) {
          return accounts.filter((account) => account.external_id === input.externalUserId);
        },
        async getAccount(id: string) {
          return accounts.find((account) => account.id === id) ?? null;
        },
        async deleteAccount(id: string) {
          accounts = accounts.filter((account) => account.id !== id);
          return true;
        },
        async proxyGet() {
          return { status: 200, body: [{ id: SITE, name: "Acme", url: "https://acme.atlassian.net" }] };
        }
      };
      const service = new JiraConnectionService(
        createTestConfig({ PIPEDREAM_CLIENT_ID: "c", PIPEDREAM_CLIENT_SECRET: "s", PIPEDREAM_PROJECT_ID: "proj_abc123" }),
        store,
        { get: async () => null },
        undefined,
        undefined,
        { warn: () => undefined },
        client as unknown as PipedreamConnectClient
      );
      const jira = (id: string, externalId: string): PipedreamAccount =>
        ({ id, external_id: externalId, app: { name_slug: "jira" }, healthy: true });

      // Migration 060 data: a mapping whose member was removed. 060 has no
      // trigger and no membership key, so the mapping stays.
      const tenant = "tenant-jira-061", user = "user-jira-061";
      const oldId = service.externalUserIdFor(tenant, user, 0);
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, $1, $1)", [tenant]);
      await db.query("INSERT INTO users (user_id, email) VALUES ($1, 'leaver@example.test')", [user]);
      await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, user]);
      await db.query(
        `INSERT INTO user_jira_connections
           (tenant_id, user_id, pipedream_external_user_id, pipedream_account_id, jira_cloud_id, jira_site_name, jira_site_url)
         VALUES ($1, $2, $3, 'apn_old', $4, 'Acme', 'https://acme.atlassian.net')`,
        [tenant, user, oldId, SITE]
      );
      await db.query("DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [tenant, user]);
      accounts = [jira("apn_old", oldId)];

      await migrate((file) => file.startsWith("061_"));

      expect((await db.query("SELECT * FROM user_jira_connections")).rows).toEqual([]);
      expect((await db.query("SELECT * FROM user_jira_identities")).rows).toEqual([expect.objectContaining({
        generation: 1, pipedream_external_user_id: null, pipedream_project_id: null
      })]);
      expect((await db.query("SELECT * FROM user_jira_cleanups")).rows).toEqual([expect.objectContaining({
        pipedream_external_user_id: oldId, pipedream_account_id: "apn_old", reason: "member_removed"
      })]);

      // The member comes back and selects a new account. Then the old
      // cleanup runs, as the removal callback and as an administrator retry.
      await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, user]);
      await service.getAuthorizationUrl({ tenantId: tenant, userId: user });
      const newId = (await store.getIdentity(tenant, user))!.externalUserId;
      expect(newId).toBe(service.externalUserIdFor(tenant, user, 1));
      accounts.push(jira("apn_new", newId));
      await service.selectConnection(tenant, user, { accountId: "apn_new", siteId: SITE });

      expect(await service.deleteConnection(tenant, user)).toBe(true);
      expect(accounts.map((account) => account.id)).toEqual(["apn_new"]);
      expect(await store.get(tenant, user)).toMatchObject({ accountId: "apn_new", externalUserId: newId });
      expect(await service.listPendingCleanups(tenant)).toEqual([]);
    });
  }, 120_000);
});
