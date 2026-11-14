// The membership read of the request middleware and /auth/refresh
// (PrivilegedAuthStateLookup) against a real Postgres with the production
// roles: one statement per call, a fresh read after each committed change,
// and the RLS scope of TenantMemberStore on the app pool. The cross-tenant
// predicate checks are in privileged-tenant-predicate.integration.test.ts.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, test } from "vitest";

import type { AppConfig } from "../config.js";
import { checkAuthAdmission } from "../lib/auth-admission.js";
import { PasswordHasher } from "../lib/password-hash.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountService, markLocalIdentityRemoved, type RequestMeta } from "../services/auth/local-account-service.js";
import { withSecurityChange } from "../services/auth/security-change.js";
import { PrivilegedAuthStateLookup, TenantMemberStore } from "../services/tenant-member-store.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const META: RequestMeta = { ipAddress: "203.0.113.9", userAgent: "integration" };
const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";
const LOCAL_LOGIN: Pick<AppConfig, "AUTH_LOGIN_TYPES"> = { AUTH_LOGIN_TYPES: ["local"] };
const AUTH_STATE_FIRST_LINE = "SELECT tm.role, t.login_type, u.auth_source, li.status AS local_status, li.security_version,";

const tokenOf = (url: string) => url.split("#token=")[1]!;
const email = () => `${randomUUID()}@example.test`;

type Statement = { via: "pool" | "client"; firstLine: string; values: unknown[] };

/** A real pool that records each statement sent through `query` or a checked-out client. */
function recordStatements(pool: pg.Pool): { pool: pg.Pool; statements: Statement[] } {
  const statements: Statement[] = [];
  const record = (via: Statement["via"], text: string, values: unknown[] = []) => {
    statements.push({ via, firstLine: text.trim().split("\n")[0]!.trim(), values });
  };
  const recordingClient = (client: pg.PoolClient) => new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return (text: string, values?: unknown[]) => {
          record("client", text, values);
          return target.query(text, values);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const recordingPool = new Proxy(pool, {
    get(target, prop) {
      if (prop === "query") {
        return (text: string, values?: unknown[]) => {
          record("pool", text, values);
          return target.query(text, values);
        };
      }
      if (prop === "connect") {
        return async () => recordingClient(await target.connect());
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { pool: recordingPool, statements };
}

describe.skipIf(!adminDatabaseUrl())("auth state lookup", () => {
  test("sends one statement on the maintenance pool, with the tenant and user as parameters", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "admin");
    const { pool, statements } = recordStatements(maintenancePool());

    expect(await new PrivilegedAuthStateLookup(pool).getAuthState(tenantId, userId)).toEqual({
      role: "admin", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null
    });
    expect(statements).toEqual([{ via: "pool", firstLine: AUTH_STATE_FIRST_LINE, values: [tenantId, userId] }]);
  });

  test("reads each committed change on the next call: status, security version, role, removal", async () => {
    const service = new LocalAccountService({
      afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(),
      hasher: new PasswordHasher(4), frontendOrigin: ORIGIN
    });
    const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, { tenantName: "Auth state", ownerEmail: email(), ownerName: "Owner" });
    await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
    const created = await service.createMember({
      tenantId: boot.tenantId, email: email(), displayName: "Member", role: "member", actorUserId: boot.userId, meta: META
    });

    // One instance for the whole test, as in app.ts: no state survives a call.
    const lookup = new PrivilegedAuthStateLookup(maintenancePool());
    const scoped = new TenantMemberStore(appPool());
    const read = async () => {
      const state = await lookup.getAuthState(boot.tenantId, created.userId);
      // The tenant-scoped read on the app pool agrees at every step.
      expect(await scoped.getAuthState(boot.tenantId, created.userId)).toEqual(state);
      return state;
    };
    const admission = async (sv: number) => checkAuthAdmission(LOCAL_LOGIN, await read(), { sv });
    const local = { role: "member", loginType: "local", authSource: "local" } as const;

    expect(await read()).toEqual({ ...local, localStatus: "pending_setup", securityVersion: 0 });
    expect(await admission(0)).toEqual({ ok: false, error: "session_revoked" });

    await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);
    expect(await read()).toEqual({ ...local, localStatus: "active", securityVersion: 1 });
    expect(await admission(1)).toMatchObject({ ok: true });

    await service.disableMember(boot.tenantId, created.userId, boot.userId, META);
    expect(await read()).toEqual({ ...local, localStatus: "disabled", securityVersion: 2 });
    expect(await admission(1)).toEqual({ ok: false, error: "session_revoked" });
    expect(await admission(2)).toEqual({ ok: false, error: "session_revoked" });

    await service.enableMember(boot.tenantId, created.userId, boot.userId, META);
    expect(await read()).toEqual({ ...local, localStatus: "active", securityVersion: 3 });
    expect(await admission(2)).toEqual({ ok: false, error: "session_revoked" });
    expect(await admission(3)).toMatchObject({ ok: true });

    // A committed role change.
    await superuserPool().query(
      `UPDATE tenant_memberships SET role = 'admin' WHERE tenant_id = $1 AND user_id = $2`,
      [boot.tenantId, created.userId]
    );
    expect(await read()).toEqual({ ...local, role: "admin", localStatus: "active", securityVersion: 3 });

    // Removal, as DELETE /tenant/members/:userId does it.
    await withSecurityChange(appPool(), boot.tenantId, IGNORE_SECURITY_CHANGE, async (client, change) => {
      await markLocalIdentityRemoved(change, created.userId);
      await client.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, created.userId]);
    });
    expect(await read()).toBeNull();
    expect(await admission(4)).toEqual({ ok: false, error: "not_a_member" });
  });

  test("on the app pool, TenantMemberStore keeps its tenant scope and the lookup finds no row", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "member");
    const { pool, statements } = recordStatements(appPool());
    const store = new TenantMemberStore(pool);

    expect(await store.getAuthState(tenantId, userId)).toMatchObject({ role: "member" });
    expect(statements).toEqual([
      { via: "client", firstLine: "BEGIN", values: [] },
      { via: "client", firstLine: "SELECT set_config('app.current_tenant_id', $1, true)", values: [tenantId] },
      { via: "client", firstLine: AUTH_STATE_FIRST_LINE, values: [tenantId, userId] },
      { via: "client", firstLine: "COMMIT", values: [] }
    ]);
    expect(await store.getActiveRole(tenantId, userId)).toBe("member");

    // Without the tenant setting, RLS hides the membership from app_user. A
    // lookup built on the wrong pool refuses every token, it admits none.
    expect(await new PrivilegedAuthStateLookup(appPool()).getAuthState(tenantId, userId)).toBeNull();
  });
});
