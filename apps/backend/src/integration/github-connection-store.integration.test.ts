import { describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { GithubConnectionStore } from "../services/integrations/github/github-connection-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("GitHub connection store", () => {
  test("a token refresh updates only the connection it started from", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "member");
    const store = new GithubConnectionStore(appPool());
    const connection = (githubUserId: string, refreshToken: string) => ({
      tenantId, userId, githubUserId, githubLogin: `login-${githubUserId}`,
      githubName: null, githubEmail: null, githubAvatarUrl: null, tokenType: "bearer",
      grantedScopes: [], accessTokenEncrypted: "access-old", accessTokenExpiresAt: null,
      refreshTokenEncrypted: refreshToken, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null
    });
    const refresh = (expectedGithubUserId: string, expectedRefreshTokenEncrypted: string) =>
      store.updateRefreshedToken({
        tenantId, userId, expectedGithubUserId, expectedRefreshTokenEncrypted,
        tokenType: "bearer", grantedScopes: ["repo"], accessTokenEncrypted: "access-new",
        accessTokenExpiresAt: null, refreshTokenEncrypted: "refresh-new", refreshTokenExpiresAt: null
      });

    await store.upsert(connection("1", "refresh-old"));
    const updated = await refresh("1", "refresh-old");
    expect(updated?.accessTokenEncrypted).toBe("access-new");
    expect(updated?.grantedScopes).toEqual(["repo"]);
    expect(updated?.tokenLastRefreshedAt).not.toBeNull();

    // A second refresh with the rotated-out token loses.
    expect(await refresh("1", "refresh-old")).toBeNull();

    // Disconnect: the refresh must not recreate the row.
    await store.delete(tenantId, userId);
    expect(await refresh("1", "refresh-new")).toBeNull();
    expect(await store.get(tenantId, userId)).toBeNull();

    // Reconnect as another account: the refresh must not overwrite it.
    await store.upsert(connection("2", "refresh-other"));
    expect(await refresh("1", "refresh-other")).toBeNull();
    expect((await store.get(tenantId, userId))?.githubUserId).toBe("2");
  });

  // ── Allowed repositories (migration 067) ──────────────────────────────────

  const connectionFor = (tenantId: string, userId: string, githubUserId: string) => ({
    tenantId, userId, githubUserId, githubLogin: `login-${githubUserId}`,
    githubName: null, githubEmail: null, githubAvatarUrl: null, tokenType: "bearer",
    grantedScopes: ["repo"], accessTokenEncrypted: "access", accessTokenExpiresAt: null,
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null
  });

  async function storedList(tenantId: string, userId: string): Promise<string[]> {
    const { rows } = await superuserPool().query<{ allowed_repositories: string[] }>(
      "SELECT allowed_repositories FROM user_github_connections WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId]
    );
    return rows[0]!.allowed_repositories;
  }

  async function member() {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "member");
    return { tenantId, userId };
  }

  test("a new connection starts with no allowed repository, and the list follows the GitHub account", async () => {
    const { tenantId, userId } = await member();
    const store = new GithubConnectionStore(appPool());

    const created = await store.upsert(connectionFor(tenantId, userId, "1"));
    expect(created.allowedRepositories).toEqual([]);

    const saved = await store.setAllowedRepositories(tenantId, userId, ["acme/app", "acme/web"], "1");
    expect(saved).toMatchObject({ status: "updated", previous: [] });
    if (saved.status === "updated") expect(saved.record.allowedRepositories).toEqual(["acme/app", "acme/web"]);
    expect(await storedList(tenantId, userId)).toEqual(["acme/app", "acme/web"]);

    // Reconnecting the same account keeps the selection.
    expect((await store.upsert(connectionFor(tenantId, userId, "1"))).allowedRepositories).toEqual(["acme/app", "acme/web"]);
    // Another account starts with none: the chosen repositories belonged to the first account.
    expect((await store.upsert(connectionFor(tenantId, userId, "2"))).allowedRepositories).toEqual([]);

    // The list survives a token refresh of the same connection.
    await store.setAllowedRepositories(tenantId, userId, ["acme/app"], "2");
    await store.upsert({ ...connectionFor(tenantId, userId, "2"), refreshTokenEncrypted: "r1" });
    await store.updateRefreshedToken({
      tenantId, userId, expectedGithubUserId: "2", expectedRefreshTokenEncrypted: "r1",
      tokenType: "bearer", grantedScopes: ["repo"], accessTokenEncrypted: "a2",
      accessTokenExpiresAt: null, refreshTokenEncrypted: "r2", refreshTokenExpiresAt: null
    });
    expect(await storedList(tenantId, userId)).toEqual(["acme/app"]);
  });

  test("setAllowedRepositories reports a missing connection and returns the previous list", async () => {
    const { tenantId, userId } = await member();
    const store = new GithubConnectionStore(appPool());

    expect(await store.setAllowedRepositories(tenantId, userId, ["acme/app"], "1")).toEqual({ status: "not_connected" });
    await store.upsert(connectionFor(tenantId, userId, "1"));
    await store.setAllowedRepositories(tenantId, userId, ["acme/app"], "1");
    const second = await store.setAllowedRepositories(tenantId, userId, ["acme/web"], "1");
    expect(second).toMatchObject({ status: "updated", previous: ["acme/app"] });
    if (second.status === "updated") expect(second.record.allowedRepositories).toEqual(["acme/web"]);
  });

  test("a list chosen for GitHub account A is refused after a reconnect as account B", async () => {
    const { tenantId, userId } = await member();
    const store = new GithubConnectionStore(appPool());
    await store.upsert(connectionFor(tenantId, userId, "A"));
    // Another tab reconnects as B. The upsert clears the list of A.
    await store.upsert(connectionFor(tenantId, userId, "B"));
    expect(await storedList(tenantId, userId)).toEqual([]);

    // The first tab saves the list that it prepared for A.
    expect(await store.setAllowedRepositories(tenantId, userId, ["a-org/secret"], "A")).toEqual({ status: "account_changed" });
    expect(await storedList(tenantId, userId)).toEqual([]);

    // The same save for B works. The store reads the account under FOR UPDATE.
    expect(await store.setAllowedRepositories(tenantId, userId, ["b-org/app"], "B")).toMatchObject({ status: "updated" });
    expect(await storedList(tenantId, userId)).toEqual(["b-org/app"]);
  });

  test("RLS: another tenant cannot read, change or move the allowed list", async () => {
    const owner = await member();
    const peer = await member();
    const store = new GithubConnectionStore(appPool());
    await store.upsert(connectionFor(owner.tenantId, owner.userId, "1"));
    await store.setAllowedRepositories(owner.tenantId, owner.userId, ["acme/app"], "1");

    // The store in the peer's scope finds no row for the owner's user id.
    expect(await store.get(peer.tenantId, owner.userId)).toBeNull();
    expect(await store.setAllowedRepositories(peer.tenantId, owner.userId, ["evil/repo"], "1")).toEqual({
      status: "not_connected"
    });

    // Raw statements in the peer's scope, without a WHERE clause, reach no row of the owner.
    const peerView = await withTenantScope(appPool(), peer.tenantId, async (client) => {
      const select = await client.query(
        "SELECT allowed_repositories FROM user_github_connections WHERE tenant_id = $1", [owner.tenantId]);
      const update = await client.query("UPDATE user_github_connections SET allowed_repositories = '{evil/repo}'");
      return { selected: select.rowCount, updated: update.rowCount };
    });
    expect(peerView).toEqual({ selected: 0, updated: 0 });
    expect(await storedList(owner.tenantId, owner.userId)).toEqual(["acme/app"]);

    // The owner cannot hand the row, with its list, to the peer tenant.
    await expect(
      withTenantScope(appPool(), owner.tenantId, (client) =>
        client.query("UPDATE user_github_connections SET tenant_id = $1", [peer.tenantId]))
    ).rejects.toMatchObject({ code: "42501" });
    expect(await storedList(owner.tenantId, owner.userId)).toEqual(["acme/app"]);
  });

  test("the database refuses a list of more than 200 repositories", async () => {
    const { tenantId, userId } = await member();
    const store = new GithubConnectionStore(appPool());
    await store.upsert(connectionFor(tenantId, userId, "1"));

    const tooMany = Array.from({ length: 201 }, (_, i) => `acme/repo-${i}`);
    await expect(store.setAllowedRepositories(tenantId, userId, tooMany, "1")).rejects.toMatchObject({ code: "23514" });
    expect(await storedList(tenantId, userId)).toEqual([]);
    const limit = tooMany.slice(0, 200);
    await store.setAllowedRepositories(tenantId, userId, limit, "1");
    expect(await storedList(tenantId, userId)).toHaveLength(200);
  });
});
