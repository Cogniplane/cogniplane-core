import { test, expect, onTestFinished, vi } from "vitest";

import Fastify, { type FastifyRequest } from "fastify";
import type { PiiProtectionSettings } from "@cogniplane/shared-types";

import { registerTenantRoutes } from "./tenant.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
import { mergeStoredPiiScopes, resolvePiiPolicy } from "../services/pii/pii-policy.js";
import { PiiSettingsConflictError, type TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import type { AuditEventInput } from "../services/audit-event-store.js";
import type { Role } from "../lib/rbac.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { recordSecurityChanges } from "../test-helpers/security-change.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { StepUpStore } from "../services/auth/step-up-store.js";
import { DataRouteControl } from "../services/data-route-control.js";
import type { DataSettingChange } from "../services/mail/setting-change-notices.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";

// ---------------------------------------------------------------------------
// In-memory TenantOrgSettingsStore for route-level tests. The real store
// encrypts API keys; the fake just stores plaintext "marker" strings — these
// tests only assert on round-trip behavior + the "configured" boolean.
// ---------------------------------------------------------------------------

type FakeOrgSettingsState = {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  marketplaceUrl: string | null;
  // The raw stored policy and its revision.
  pii: unknown;
  piiRevision: number;
};

function makeFakeOrgSettingsStore(initial: Partial<FakeOrgSettingsState> = {}): {
  store: TenantOrgSettingsStore;
  state: FakeOrgSettingsState & { audits: AuditEventInput[] };
} {
  const state: FakeOrgSettingsState & { audits: AuditEventInput[] } = {
    openaiApiKey: initial.openaiApiKey ?? null,
    anthropicApiKey: initial.anthropicApiKey ?? null,
    marketplaceUrl: initial.marketplaceUrl ?? null,
    pii: initial.pii ?? null,
    piiRevision: initial.piiRevision ?? 0,
    audits: []
  };
  const store = {
    async get(_tenantId: string) {
      return {
        tenantId: _tenantId,
        providerKeys: {
          anthropic: Boolean(state.anthropicApiKey),
          openai: Boolean(state.openaiApiKey),
          google: false,
          openrouter: false,
          zai: false
        },
        skillMarketplaceManifestUrl: state.marketplaceUrl,
        storedPiiProtection: state.pii,
        piiProtectionRevision: state.piiRevision,
        updatedAt: new Date().toISOString()
      };
    },
    async getDecryptedApiKey(_tenantId: string, provider: string) {
      if (provider === "openai") return state.openaiApiKey;
      if (provider === "anthropic") return state.anthropicApiKey;
      return null;
    },
    async setApiKey(_tenantId: string, provider: string, apiKey: string | null, audit?: AuditEventInput) {
      if (provider === "openai") state.openaiApiKey = apiKey;
      else if (provider === "anthropic") state.anthropicApiKey = apiKey;
      if (audit) state.audits.push(audit);
    },
    async setMarketplaceUrl(_tenantId: string, url: string | null, audit?: AuditEventInput) {
      state.marketplaceUrl = url;
      if (audit) state.audits.push(audit);
    },
    // The store contract: a revision that is not the stored one writes
    // nothing; then a weaker save that is not allowed writes nothing. The
    // audit event (with its owner notice) is part of the change.
    async setPiiProtection(
      _tenantId: string,
      policy: PiiProtectionSettings,
      options: Parameters<TenantOrgSettingsStore["setPiiProtection"]>[2]
    ) {
      if (options.expectedRevision !== undefined && options.expectedRevision !== state.piiRevision) {
        throw new PiiSettingsConflictError();
      }
      const stored = mergeStoredPiiScopes(policy, state.pii);
      const weaker = options.weakerFields(state.pii, stored);
      if (weaker.length > 0 && !options.allowWeaker) throw new WeakerChangeError();
      state.pii = stored;
      state.piiRevision += 1;
      if (options.audit) {
        const event = options.audit(stored, state.piiRevision, weaker);
        state.audits.push(event);
        await event.alsoInTransaction?.({} as never);
      }
      return { stored, revision: state.piiRevision };
    }
  } as unknown as TenantOrgSettingsStore;
  return { store, state };
}

// ---------------------------------------------------------------------------
// In-memory DB serving GET /tenant's `SELECT tenant_id ... FROM tenants`.
// All settings live in the org-settings store, not in tenants.settings_json.
// ---------------------------------------------------------------------------

function makeTenantsDb() {
  const queryFn = async (text: string) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) {
      return { rows: [] };
    }
    if (text.includes("SELECT tenant_id")) {
      return {
        rows: [
          {
            tenant_id: "tenant-1",
            tenant_name: "Test Tenant",
            slug: "test",
            sso_provider: null,
            plan: "free",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ]
      };
    }
    return { rows: [] };
  };
  const client = { query: queryFn, release: () => {} };
  return {
    query: queryFn,
    connect: async () => client
  };
}

function makeOrgSettingsApp(role: Role = "owner", session?: NonNullable<FastifyRequest["auth"]["session"]>) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "user-1",
      tenantId: "tenant-1",
      role,
      isAdmin: role === "admin",
      ...(session ? { session } : {})
    };
  });
  return app;
}

test("tenant member listing runs through the RLS-bound tenant scope", async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let released = false;
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("FROM tenant_memberships tm")) {
        return {
          rows: [
            {
              user_id: "member-user",
              email: "member@example.com",
              display_name: "Member",
              role: "member",
              created_at: "2026-06-10T00:00:00.000Z"
            }
          ]
        };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  const db = {
    async connect() {
      return client;
    },
    async query() {
      throw new Error("tenant member listing must not use an unscoped pool query");
    }
  };
  const app = makeOrgSettingsApp("admin");
  onTestFinished(async () => {
    await app.close();
  });
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE,
    db: db as never,
    tenantOrgSettings: makeFakeOrgSettingsStore().store
  });

  const response = await app.inject({ method: "GET", url: "/tenant/members" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    {
      userId: "member-user",
      email: "member@example.com",
      displayName: "Member",
      role: "member",
      joinedAt: "2026-06-10T00:00:00.000Z",
      accountStatus: null,
      lastLoginAt: null
    }
  ]);
  expect(queries.map((query) => query.text)).toEqual([
    "BEGIN",
    "SELECT set_config('app.current_tenant_id', $1, true)",
    expect.stringContaining("FROM tenant_memberships tm"),
    "COMMIT"
  ]);
  expect(queries[1]?.values).toEqual(["tenant-1"]);
  expect(released).toBe(true);
});

test("tenant role updates reject demoting an owner", async () => {
  let updateCalled = false;
  const client = {
    async query(text: string) {
      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      // A WorkOS member: no step-up, and no local identity to lock.
      if (text.includes("SELECT user_auth_source FROM tenant_memberships")) return { rows: [{ user_auth_source: "workos" }] };
      if (text.includes("FROM local_identities")) return { rows: [], rowCount: 0 };
      // The member's chats, locked before the membership (session-execution-store.ts).
      if (text.includes("FROM sessions s") && text.includes("FOR UPDATE OF s")) return { rows: [] };
      // The caller's own version, as the local session carries it.
      if (text.includes("FOR SHARE") && text.includes("security_version")) return { rows: [{ security_version: 1 }] };
      if (text.includes("AS actor_role")) return { rows: [{ actor_role: "admin" }] };
      if (text.includes("SELECT role FROM tenant_memberships")) {
        return { rows: [{ role: "owner" }] };
      }
      if (text.includes("UPDATE tenant_memberships SET role")) {
        updateCalled = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  };

  const app = Fastify();
  onTestFinished(async () => {
        await app.close();
      });

  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "tenant-1",
      role: "admin",
      isAdmin: true
    };
  });

  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/owner-user/role",
    payload: { role: "member" }
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "cannot_demote_owner" });
  expect(updateCalled).toBe(false);
});

test("tenant role updates still allow changing a non-owner member", async () => {
  const client = {
    async query(text: string, values: unknown[]) {
      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("SELECT user_auth_source FROM tenant_memberships")) return { rows: [{ user_auth_source: "workos" }] };
      if (text.includes("FROM local_identities")) return { rows: [], rowCount: 0 };
      // The member's chats, locked before the membership (session-execution-store.ts).
      if (text.includes("FROM sessions s") && text.includes("FOR UPDATE OF s")) return { rows: [] };
      // The caller's own version, as the local session carries it.
      if (text.includes("FOR SHARE") && text.includes("security_version")) return { rows: [{ security_version: 1 }] };
      if (text.includes("AS actor_role")) return { rows: [{ actor_role: "owner" }] };
      if (text.includes("SELECT role FROM tenant_memberships")) {
        return { rows: [{ role: "member" }] };
      }
      if (text.includes("UPDATE tenant_memberships SET role")) {
        return {
          rows: [{ tenant_id: values[1], user_id: values[2], role: values[0] }]
        };
      }
      if (text.includes("INSERT INTO audit_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  };

  const app = Fastify();
  onTestFinished(async () => {
        await app.close();
      });

  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "owner-user",
      tenantId: "tenant-1",
      role: "owner",
      isAdmin: true
    };
  });

  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/member-user/role",
    payload: { role: "admin" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        tenant_id: "tenant-1",
        user_id: "member-user",
        role: "admin"
      });
});

// ---------------------------------------------------------------------------
// Member-management routes share this fake DB. It serves the membership
// SELECT (driven by `targetRole`) and records whether the role-UPDATE or the
// member-DELETE was ever issued — those negative "no write happened" flags are
// the load-bearing privilege-escalation assertions. `deleteValues` captures
// the bind values of the DELETE so we can assert membership identity by value
// (tenantId + targetUserId) without depending on positional bind order.
// ---------------------------------------------------------------------------

function makeMembersDb(targetRole: string | null, targetAuthSource: "workos" | "local" = "workos") {
  const tracked = {
    connectCalled: false,
    deleteCalled: false,
    updateCalled: false,
    deleteValues: null as unknown[] | null,
    updateValues: null as unknown[] | null,
    disableJobsCalled: false,
    disableJobsValues: null as unknown[] | null,
    audits: [] as Array<{ type: unknown; payload: unknown }>,
    /** The target's local account status, when the target is local. */
    localStatus: "active" as string,
    /** Overrides the caller's committed role, for a demotion mid-request. */
    actorRoles: {} as Record<string, string>,
    // Order matters: the jobs must be disabled in the same transaction as the
    // membership delete, so both statements are recorded in sequence.
    statements: [] as string[]
  };
  const client = {
    async query(text: string, values: unknown[]) {
      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (text.includes("pg_advisory_xact_lock")) {
        tracked.statements.push("lock_tenant");
        return { rows: [] };
      }
      // The caller's role as committed now: the tests name callers by role.
      // The caller's own version, as the local session carries it.
      if (text.includes("FOR SHARE") && text.includes("security_version")) return { rows: [{ security_version: 1 }] };
      if (text.includes("AS actor_role")) {
        const actor = String(values[1]);
        const roleOf = tracked.actorRoles[actor] ?? (actor === "owner-user" ? "owner" : actor === "admin-user" ? "admin" : "member");
        return { rows: [{ actor_role: roleOf }] };
      }
      if (text.includes("SELECT user_auth_source FROM tenant_memberships")) {
        return { rows: targetRole === null ? [] : [{ user_auth_source: targetAuthSource }] };
      }
      // The member's chats, then their leases and sandboxes (session-execution-store.ts).
      if (text.includes("FROM sessions s") && text.includes("FOR UPDATE OF s")) {
        tracked.statements.push("lock_chats");
        return { rows: [] };
      }
      if (text.includes("UPDATE session_executions")) {
        tracked.statements.push("stop_leases");
        return { rows: [] };
      }
      if (text.includes("UPDATE sessions s SET sandbox_id=NULL")) {
        tracked.statements.push("take_sandboxes");
        return { rows: [] };
      }
      if (text.includes("FROM local_identities") && text.includes("FOR UPDATE")) {
        tracked.statements.push("lock_identity");
        const local = targetRole !== null && targetAuthSource === "local";
        return { rows: local ? [{ status: tracked.localStatus }] : [], rowCount: local ? 1 : 0 };
      }
      if (/SELECT role(, user_auth_source)? FROM tenant_memberships/.test(text)) {
        tracked.statements.push("lock_membership");
        return { rows: targetRole === null ? [] : [{ role: targetRole, user_auth_source: targetAuthSource }] };
      }
      if (text.includes("UPDATE auth_action_tokens")) {
        tracked.statements.push("cancel_links");
        return { rows: [] };
      }
      if (text.includes("SELECT mfa_policy FROM tenants")) return { rows: [{ mfa_policy: "optional" }] };
      if (text.includes("UPDATE local_identities")) {
        tracked.statements.push("mark_local_removed");
        return { rows: [] };
      }
      if (text.includes("DELETE FROM user_totp_factors") || text.includes("DELETE FROM user_passkeys") || text.includes("DELETE FROM user_recovery_codes")) {
        tracked.statements.push("delete_second_factors");
        return { rows: [] };
      }
      if (text.includes("DELETE FROM local_passwords") || text.includes("DELETE FROM auth_action_tokens")) {
        tracked.statements.push("delete_local_credentials");
        return { rows: [] };
      }
      if (text.includes("UPDATE tenant_memberships SET role")) {
        tracked.updateCalled = true;
        tracked.updateValues = values;
        return { rows: [{ tenant_id: values[1], user_id: values[2], role: values[0] }] };
      }
      if (text.includes("UPDATE scheduled_jobs")) {
        tracked.disableJobsCalled = true;
        tracked.disableJobsValues = values;
        tracked.statements.push("disable_jobs");
        return { rows: [] };
      }
      if (text.includes("DELETE FROM tenant_memberships")) {
        tracked.deleteCalled = true;
        tracked.deleteValues = values;
        tracked.statements.push("delete_membership");
        return { rows: [] };
      }
      if (text.includes("INSERT INTO audit_events")) {
        tracked.audits.push({ type: values[4], payload: JSON.parse(String(values[5])) });
        tracked.statements.push("audit");
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  const db = {
    async connect() {
      tracked.connectCalled = true;
      return client;
    }
  };
  return { db, tracked };
}

function makeMembersApp(role: Role, userId: string) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId,
      tenantId: "tenant-1",
      role,
      isAdmin: role === "admin"
    };
  });
  return app;
}

test("DELETE member: removing yourself returns 400 cannot_remove_self and never issues a DELETE", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/admin-user" });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "cannot_remove_self" });
  // Self-removal is rejected before opening a tenant-scoped transaction.
  expect(tracked.deleteCalled).toBe(false);
});

test("DELETE member: rejects a malformed userId before opening a transaction", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/bad!id" });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: "invalid_request" });
  expect(tracked.connectCalled).toBe(false);
});

test("DELETE member: removing an owner returns 403 cannot_remove_owner and never issues a DELETE", async () => {
  const { db, tracked } = makeMembersDb("owner");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/other-owner" });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "cannot_remove_owner" });
  expect(tracked.deleteCalled).toBe(false);
});

test("DELETE member: an admin cannot remove another admin, but an owner can", async () => {
  const { db, tracked } = makeMembersDb("admin");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/other-admin" });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "only_owner_can_remove_admin" });
  expect(tracked.deleteCalled).toBe(false);
  expect(tracked.disableJobsCalled).toBe(false);
  expect(tracked.audits).toEqual([]);

  const owner = makeMembersDb("admin");
  const ownerApp = makeMembersApp("owner", "owner-user");
  onTestFinished(() => ownerApp.close());
  await registerTenantRoutes(ownerApp, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: owner.db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await ownerApp.ready();

  const ownerResponse = await ownerApp.inject({ method: "DELETE", url: "/tenant/members/other-admin" });

  expect(ownerResponse.statusCode).toBe(200);
  expect(owner.tracked.deleteCalled).toBe(true);
});

test("DELETE member: unknown member returns 404 member_not_found and never issues a DELETE", async () => {
  const { db, tracked } = makeMembersDb(null);
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/ghost-user" });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "member_not_found" });
  expect(tracked.deleteCalled).toBe(false);
});

test("DELETE member: happy path returns 200 and fires DELETE scoped to tenant + target user", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/member-user" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(tracked.deleteCalled).toBe(true);
  // Assert by value membership so the test does not couple to bind ordering:
  // the DELETE must be scoped to this tenant AND this target user.
  expect(tracked.deleteValues).toContain("tenant-1");
  expect(tracked.deleteValues).toContain("member-user");
  // The audit event is written in the membership transaction, after the delete.
  // The transaction then takes the member's sandboxes.
  expect(tracked.statements.slice(-4)).toEqual(["audit", "lock_chats", "stop_leases", "take_sandboxes"]);
  expect(tracked.audits).toEqual([
    { type: "tenant.member.removed", payload: { targetUserId: "member-user", previousRole: "member" } }
  ]);
});

// A local account has no other tenant, so removal ends it in the same
// transaction: removed status, new security version, no password, no links.
// WorkOS members never touch the local tables.
// Local accounts: removal needs the manager's step-up proof, and every change
// of a local account locks the identity first, then the membership, then the
// jobs. Removal ends the account in the same transaction.
function localStepUp(valid: boolean) {
  return {
    stepUp: { consume: vi.fn(async () => (valid ? ["pwd"] : null)) },
    refreshTokens: { isActive: vi.fn(async () => true) },
    mfa: { hasSecondFactor: vi.fn(async () => false) }
  } as never;
}

function makeLocalManagerApp(role: Role, userId: string) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId, tenantId: "tenant-1", role, isAdmin: role !== "member",
      session: { authSource: "local", familyId: "family-1", securityVersion: 1 }
    };
  });
  return app;
}

test.each(["workos", "local"] as const)("DELETE member: a %s member's local account state", async (authSource) => {
  const { db, tracked } = makeMembersDb("member", authSource);
  const app = makeLocalManagerApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localStepUp(true) });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/member-user", headers: { "x-step-up": "t".repeat(43) } });

  expect(response.statusCode).toBe(200);
  const localSteps = tracked.statements.filter((step) =>
    step === "mark_local_removed" || step === "delete_local_credentials" || step === "delete_second_factors");
  expect(localSteps).toEqual(
    authSource === "local"
      ? ["mark_local_removed", "delete_local_credentials", "delete_local_credentials", "delete_second_factors", "delete_second_factors", "delete_second_factors"]
      : []
  );
  // Identity, then the member's chats, then membership, then jobs: the order
  // disable uses too, with the chats where turn admission takes them. The
  // sandbox release at the end locks the chats again (they are already held).
  const order = ["lock_tenant", "lock_identity", "lock_chats", "lock_membership", "disable_jobs", "delete_membership"];
  expect(tracked.statements.filter((step) => order.includes(step))).toEqual([...order, "lock_chats"]);
  if (authSource === "local") {
    expect(tracked.statements.indexOf("mark_local_removed")).toBeLessThan(tracked.statements.indexOf("delete_membership"));
  }
});

test.each([
  ["no step-up token", false],
  ["a refused step-up token", true]
])("DELETE member: a local member cannot be removed with %s", async (_case, sendHeader) => {
  const { db, tracked } = makeMembersDb("member", "local");
  // Also without a local session: the target's login path decides.
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localStepUp(false) });
  await app.ready();

  const response = await app.inject({
    method: "DELETE",
    url: "/tenant/members/member-user",
    ...(sendHeader ? { headers: { "x-step-up": "t".repeat(43) } } : {})
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: "step_up_required" });
  expect(tracked.deleteCalled).toBe(false);
});

// The middleware read the caller's role when the request started. A demotion
// that commits before the change must win: the routes read the role again.
test.each([
  ["remove a member", "DELETE", undefined],
  ["change a member's role", "PUT", { role: "member" }]
] as const)("a manager demoted mid-request cannot %s", async (_case, method, payload) => {
  const { db, tracked } = makeMembersDb("member");
  tracked.actorRoles["admin-user"] = "member";
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method,
    url: method === "PUT" ? "/tenant/members/member-user/role" : "/tenant/members/member-user",
    ...(payload ? { payload } : {})
  });

  expect(response.statusCode).toBe(403);
  expect(tracked.deleteCalled).toBe(false);
  expect(tracked.updateCalled).toBe(false);
});

test.each(["pending_setup", "disabled"])("PUT member role: a %s local account cannot become an owner", async (status) => {
  const { db, tracked } = makeMembersDb("member", "local");
  tracked.localStatus = status;
  const app = makeLocalManagerApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localStepUp(true) });
  await app.ready();

  const response = await app.inject({
    method: "PUT", url: "/tenant/members/member-user/role", payload: { role: "owner" }, headers: { "x-step-up": "t".repeat(43) }
  });

  // Nobody could reset or enable that owner afterwards.
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "account_not_active" });
  expect(tracked.updateCalled).toBe(false);
});

test("PUT member role: promoting a local member locks the identity first and cancels open links", async () => {
  const { db, tracked } = makeMembersDb("member", "local");
  const app = makeLocalManagerApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localStepUp(true) });
  await app.ready();

  const response = await app.inject({
    method: "PUT", url: "/tenant/members/member-user/role", payload: { role: "owner" }, headers: { "x-step-up": "t".repeat(43) }
  });

  expect(response.statusCode).toBe(200);
  // A reset link an admin got for this member must not survive the promotion.
  expect(tracked.statements.filter((step) => ["lock_tenant", "lock_identity", "lock_chats", "lock_membership", "cancel_links"].includes(step)))
    .toEqual(["lock_tenant", "lock_identity", "lock_chats", "lock_membership", "cancel_links"]);
});

// A role decides what an account can do. With a stolen owner token, an
// attacker could otherwise make an account they control an owner.
test("PUT member role: a local member's role changes only with the manager's step-up for member.role_change", async () => {
  const { db, tracked } = makeMembersDb("member", "local");
  const localAuth = localStepUp(true) as unknown as { stepUp: { consume: ReturnType<typeof vi.fn> } };
  const app = makeLocalManagerApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localAuth as never });
  await app.ready();

  const response = await app.inject({
    method: "PUT", url: "/tenant/members/member-user/role", payload: { role: "admin" }, headers: { "x-step-up": "t".repeat(43) }
  });

  expect(response.statusCode).toBe(200);
  expect(tracked.updateCalled).toBe(true);
  expect(localAuth.stepUp.consume).toHaveBeenCalledTimes(1);
  expect(localAuth.stepUp.consume).toHaveBeenCalledWith("t".repeat(43), {
    userId: "owner-user", tenantId: "tenant-1", familyId: "family-1", securityVersion: 1, action: "member.role_change"
  });
});

test.each([
  ["a local session without a step-up token", true, false],
  ["a local session with a refused step-up token", true, true],
  // The target's login path decides: a WorkOS session cannot give a step-up.
  ["a WorkOS session", false, true]
] as const)("PUT member role: a local member's role does not change from %s", async (_case, localSession, sendHeader) => {
  const { db, tracked } = makeMembersDb("member", "local");
  const app = localSession ? makeLocalManagerApp("owner", "owner-user") : makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localStepUp(false) });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/member-user/role",
    payload: { role: "owner" },
    ...(sendHeader ? { headers: { "x-step-up": "t".repeat(43) } } : {})
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: "step_up_required" });
  expect(tracked.updateCalled).toBe(false);
  // Refused before the membership transaction: no lock, no audit.
  expect(tracked.statements).toEqual([]);
});

test("PUT member role: a WorkOS member's role changes with no step-up, also when local login is on", async () => {
  const { db, tracked } = makeMembersDb("member", "workos");
  const localAuth = localStepUp(false) as unknown as { stepUp: { consume: ReturnType<typeof vi.fn> } };
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store, localAuth: localAuth as never });
  await app.ready();

  const response = await app.inject({ method: "PUT", url: "/tenant/members/member-user/role", payload: { role: "admin" } });

  expect(response.statusCode).toBe(200);
  expect(tracked.updateCalled).toBe(true);
  expect(localAuth.stepUp.consume).not.toHaveBeenCalled();
});

test("PUT member role: a local member's role needs step-up also when local login is off", async () => {
  const { db, tracked } = makeMembersDb("member", "local");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "PUT", url: "/tenant/members/member-user/role", payload: { role: "admin" } });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: "step_up_required" });
  expect(tracked.updateCalled).toBe(false);
});

test("DELETE member: after the commit, stops the removed member's active work (a WorkOS member too)", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("admin", "admin-user");
  const securityChanges = recordSecurityChanges();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, {
    dataRoutes: devDataRoutes(),
    afterSecurityChange: securityChanges.after,
    db: db as never,
    tenantOrgSettings: makeFakeOrgSettingsStore().store
  });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/member-user" });

  expect(response.statusCode).toBe(200);
  expect(tracked.deleteCalled).toBe(true);
  expect(securityChanges.calls).toEqual([{ tenantId: "tenant-1", userIds: ["member-user"], releasedSandboxes: [] }]);
});

test("DELETE member: a refused removal stops nothing", async () => {
  const { db } = makeMembersDb("owner");
  const app = makeMembersApp("admin", "admin-user");
  const securityChanges = recordSecurityChanges();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, {
    dataRoutes: devDataRoutes(),
    afterSecurityChange: securityChanges.after,
    db: db as never,
    tenantOrgSettings: makeFakeOrgSettingsStore().store
  });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/member-user" });

  expect(response.statusCode).toBe(403);
  expect(securityChanges.calls).toEqual([]);
});

test("DELETE member: disables the removed member's scheduled jobs in the same transaction", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/member-user" });

  expect(response.statusCode).toBe(200);
  // Left enabled, these keep running as synthetic turns under the removed
  // user's identity and stored OAuth tokens.
  expect(tracked.disableJobsCalled).toBe(true);
  expect(tracked.disableJobsValues).toContain("tenant-1");
  expect(tracked.disableJobsValues).toContain("member-user");
  // Both statements ran on the same client, before the commit — the disable is
  // not a best-effort follow-up that a crash could skip.
  // The member's sandboxes are taken last, in the same transaction.
  expect(tracked.statements).toEqual([
    "lock_tenant", "lock_identity", "lock_chats", "lock_membership", "disable_jobs", "delete_membership", "audit",
    "lock_chats", "stop_leases", "take_sandboxes"
  ]);
});

test("DELETE member: an owner rejection disables no jobs", async () => {
  const { db, tracked } = makeMembersDb("owner");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({ method: "DELETE", url: "/tenant/members/other-owner" });

  expect(response.statusCode).toBe(403);
  expect(tracked.disableJobsCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// PUT /tenant/members/:userId/role  (privilege guards)
// ---------------------------------------------------------------------------

test("PUT member role: invalid role value returns 400 invalid_role and never issues an UPDATE", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/member-user/role",
    payload: { role: "superuser" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "invalid_role" });
  expect(tracked.updateCalled).toBe(false);
});

test("PUT member role: rejects an oversized userId before opening a transaction", async () => {
  const { db, tracked } = makeMembersDb("member");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: `/tenant/members/${"u".repeat(81)}/role`,
    payload: { role: "member" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: "invalid_request" });
  expect(tracked.connectCalled).toBe(false);
});

test("SECURITY REGRESSION: PUT member role — a non-owner admin cannot assign owner; rejected 403 before any DB write", async () => {
  const { db, tracked } = makeMembersDb("member");
  // Actor is an admin, NOT an owner — escalating a member to owner is forbidden.
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/member-user/role",
    payload: { role: "owner" }
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "only_owner_can_assign_owner" });
  // The guard must short-circuit before the membership lookup OR the UPDATE.
  expect(tracked.updateCalled).toBe(false);
});

test("SECURITY REGRESSION: PUT member role — a non-owner admin cannot demote another admin to member", async () => {
  const { db, tracked } = makeMembersDb("admin");
  const app = makeMembersApp("admin", "admin-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/other-admin/role",
    payload: { role: "member" }
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "only_owner_can_change_admin_role" });
  expect(tracked.updateCalled).toBe(false);
});

test("PUT member role: an owner can demote an admin to member", async () => {
  const { db, tracked } = makeMembersDb("admin");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/other-admin/role",
    payload: { role: "member" }
  });

  expect(response.statusCode).toBe(200);
  expect(tracked.updateCalled).toBe(true);
  expect(tracked.audits).toEqual([{
    type: "tenant.member.role_changed",
    payload: { targetUserId: "other-admin", previousRole: "admin", role: "member" }
  }]);
});

test("PUT member role: changing your own role returns 400 cannot_change_own_role and never issues an UPDATE", async () => {
  const { db, tracked } = makeMembersDb("owner");
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/owner-user/role",
    payload: { role: "admin" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "cannot_change_own_role" });
  expect(tracked.updateCalled).toBe(false);
});

test("PUT member role: unknown member returns 404 member_not_found and never issues an UPDATE", async () => {
  const { db, tracked } = makeMembersDb(null);
  const app = makeMembersApp("owner", "owner-user");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/ghost-user/role",
    payload: { role: "admin" }
  });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "member_not_found" });
  expect(tracked.updateCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// PUT /tenant/settings (provider key set/clear)
// ---------------------------------------------------------------------------

test("provider key: a non-empty apiKey is stored for the selected provider", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings",
    payload: { provider: "openai", apiKey: "sk-openai-new" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().ok).toBe(true);
  expect(state.openaiApiKey).toBe("sk-openai-new");
  // The audit records that a key changed, never the key.
  expect(state.audits).toEqual([expect.objectContaining({
    tenantId: "tenant-1",
    userId: "user-1",
    type: "tenant.provider_key.updated",
    payload: { provider: "openai", keySet: true }
  })]);
});

test("provider key: an empty apiKey CLEARS the selected provider's key (R11)", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ anthropicApiKey: "sk-ant-existing" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings",
    payload: { provider: "anthropic", apiKey: "" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().ok).toBe(true);
  // The stored key is revoked, not left in place.
  expect(state.anthropicApiKey).toBe(null);
  expect(response.json().providerKeys.anthropic).toBe(false);
});

test.each([
  {},
  { anthropicApiKey: "sk-ant-legacy" },
  { provider: "anthropic" },
  { apiKey: "sk-ant-new" },
  { provider: "anthropic", apiKey: "", anthropicApiKey: "sk-ant-legacy" },
  { provider: "invalid", apiKey: "" },
  { provider: "anthropic", apiKey: null },
  { provider: "anthropic", apiKey: "x".repeat(513) }
])("provider key: rejects invalid or obsolete payload %j without changing keys", async (payload) => {
  const { store, state } = makeFakeOrgSettingsStore({
    anthropicApiKey: "sk-ant-existing",
    openaiApiKey: "sk-openai-existing"
  });
  const before = { ...state };
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store });

  const response = await app.inject({ method: "PUT", url: "/tenant/settings", payload });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("invalid_request");
  expect(state).toEqual(before);
});

test("tenant responses expose provider presence without compatibility aliases", async () => {
  const { store } = makeFakeOrgSettingsStore({ anthropicApiKey: "sk-ant-existing" });
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store });

  const details = await app.inject({ method: "GET", url: "/tenant" });
  expect(details.statusCode).toBe(200);
  expect(details.json().settings.providerKeys.anthropic).toBe(true);
  expect(details.json().settings).not.toHaveProperty("anthropicApiKeyConfigured");
  // The settings name no overlay integration. Overlays report status from their own routes.
  expect(Object.keys(details.json().settings).sort()).toEqual(
    ["github", "piiProtection", "piiProtectionHealth", "piiProtectionRevision", "providerKeys", "skillMarketplaceManifestUrl"]
  );

  const update = await app.inject({
    method: "PUT", url: "/tenant/settings",
    payload: { provider: "openai", apiKey: "  sk-openai-new  " }
  });
  expect(update.statusCode).toBe(200);
  expect(update.json()).toEqual({
    ok: true,
    providerKeys: { anthropic: true, openai: true, google: false, openrouter: false, zai: false }
  });
});

test("marketplace: valid URL is stored and returned", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "https://example.com/manifest.json" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        ok: true,
        skillMarketplaceManifestUrl: "https://example.com/manifest.json"
      });
  expect(state.marketplaceUrl).toBe("https://example.com/manifest.json");
});

test("marketplace: empty string is stored as null", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: null is stored as null", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: null }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: whitespace-only string is stored as null, not a 400", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "   " }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: invalid URL returns 400 invalid_url", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "not-a-url" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "invalid_url" });
});

test("marketplace: http:// URL returns 400 invalid_url (SSRF protection)", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  for (const badUrl of ["http://example.com/manifest.json", "file:///etc/passwd", "ftp://example.com/x"]) {
    const response = await app.inject({
      method: "PUT",
      url: "/tenant/settings/marketplace",
      payload: { skillMarketplaceManifestUrl: badUrl }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_url" });
  }
});

test("marketplace: private/reserved IP URLs are rejected (SSRF protection)", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const ssrfUrls = [
    // AWS IMDS — the canonical SSRF target on EC2/ECS hosts.
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    // Loopback / localhost.
    "https://127.0.0.1/manifest.json",
    "https://127.0.0.1:8080/manifest.json",
    // RFC1918 private ranges.
    "https://10.0.0.1/manifest.json",
    "https://192.168.1.1/manifest.json",
    "https://172.16.0.1/manifest.json",
    // IPv6 loopback.
    "https://[::1]/manifest.json",
    // Numeric-shaped formats the OS resolver may still treat as IPs.
    "https://2130706433/manifest.json", // 32-bit form of 127.0.0.1
    "https://0177.0.0.1/manifest.json"  // octal-shaped 127.0.0.1
  ];

  for (const ssrfUrl of ssrfUrls) {
    const response = await app.inject({
      method: "PUT",
      url: "/tenant/settings/marketplace",
      payload: { skillMarketplaceManifestUrl: ssrfUrl }
    });
    expect(response.statusCode, `expected 400 for ${ssrfUrl}`).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_url" });
  }

  // Critical: the store must NOT have been touched by any of the rejected URLs.
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: URL longer than 2048 chars returns 400 url_too_long", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const longUrl = "https://example.com/" + "a".repeat(2048);
  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: longUrl }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "url_too_long" });
});

test("marketplace: member role returns 403", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp("member");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "https://example.com/manifest.json" }
  });

  expect(response.statusCode).toBe(403);
});

test("GET /tenant response includes skillMarketplaceManifestUrl", async () => {
  const { store } = makeFakeOrgSettingsStore({
    marketplaceUrl: "https://example.com/manifest.json"
  });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.skillMarketplaceManifestUrl).toBe("https://example.com/manifest.json");
});

test("GET /tenant returns default piiProtection when setting is absent", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.piiProtection).toBeTruthy();
  expect(body.settings.piiProtection.enabled).toBe(false);
  expect(body.settings.piiProtection.mode).toBe("off");
  expect(body.settings.piiProtection.rawRetention).toBe("never");
  expect(body.settings.piiProtection.provider.type).toBe("openai-compatible");
  expect(body.settings.piiProtection.scopes.chatPrompts).toBe(true);
  expect(Array.isArray(body.settings.piiProtection.detectors.entityTypes)).toBeTruthy();
});

test("GET /tenant returns stored piiProtection when present and valid", async () => {
  const validPolicy = {
    enabled: true,
    mode: "detect",
    rawRetention: "never",
    provider: { type: "openai-compatible", model: "meta/llama-guard" },
    scopes: { chatPrompts: true, uploads: false, retiredImports: true },
    actions: { reportToAdmins: true },
    detectors: { useRulesFirst: true, entityTypes: ["email", "phone"] }
  };
  const { store } = makeFakeOrgSettingsStore({ pii: validPolicy });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.piiProtection.enabled).toBe(true);
  expect(body.settings.piiProtection.mode).toBe("detect");
  expect(body.settings.piiProtection.provider.model).toBe("meta/llama-guard");
  // A scope that no import source registered is not configurable here.
  expect(body.settings.piiProtection.scopes).toEqual({ chatPrompts: true, uploads: false });
  expect(body.settings.piiProtection.detectors.entityTypes).toEqual(["email", "phone"]);
});

const VALID_PII_PAYLOAD = {
  enabled: true,
  mode: "detect" as const,
  rawRetention: "never" as const,
  provider: { type: "openai-compatible" as const, model: "meta/llama-guard" },
  scopes: { chatPrompts: true, uploads: true },
  actions: { reportToAdmins: true },
  detectors: { useRulesFirst: true, entityTypes: ["email", "phone"] as const }
};

async function putPii(options: { payload: Record<string, unknown>; stored?: unknown; storedRevision?: number; piiImportScopes?: PiiImportScopeRegistry }) {
  const { store, state } = makeFakeOrgSettingsStore({ pii: options.stored ?? null, piiRevision: options.storedRevision });
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store, piiImportScopes: options.piiImportScopes });
  await app.ready();
  const response = await app.inject({ method: "PUT", url: "/tenant/settings/pii", payload: options.payload });
  return { response, state };
}

function registryWith(scopeKey: string, subjectKind: string) {
  const registry = new PiiImportScopeRegistry();
  registry.register({ subjectKind, scopeKey, defaultOn: true });
  return registry;
}

test("PUT /tenant/settings/pii accepts a registered import scope and returns it", async () => {
  const payload = { ...VALID_PII_PAYLOAD, scopes: { chatPrompts: true, uploads: true, partnerImports: false } };
  const { response, state } = await putPii({ payload, piiImportScopes: registryWith("partnerImports", "partner_import") });
  expect(response.statusCode).toBe(200);
  expect(response.json().piiProtection.scopes).toEqual(payload.scopes);
  expect(state.pii).toEqual(payload);
});

test("PUT /tenant/settings/pii rejects a scope key that no source registered", async () => {
  const payload = { ...VALID_PII_PAYLOAD, scopes: { chatPrompts: true, uploads: true, partnerImports: false } };
  const { response, state } = await putPii({ payload });
  expect(response.statusCode).toBe(400);
  expect(response.json().details).toEqual([expect.objectContaining({ path: "scopes" })]);
  expect(state.pii).toBeNull();
});

// A frontend from before import sources moved to overlays sends the legacy key on every save.
test.each([
  ["with the overlay", registryWith("microsoftImports", "microsoft_import"), { chatPrompts: true, uploads: true, microsoftImports: false }],
  ["without the overlay", undefined, { chatPrompts: true, uploads: true }]
])("PUT /tenant/settings/pii accepts a legacy frontend save %s", async (_name, piiImportScopes, shownScopes) => {
  const payload = { ...VALID_PII_PAYLOAD, scopes: { chatPrompts: true, uploads: true, microsoftImports: false } };
  const { response, state } = await putPii({ payload, piiImportScopes });
  expect(response.statusCode).toBe(200);
  expect(response.json().piiProtection.scopes).toEqual(shownScopes);
  // The stored key is the same in both builds.
  expect((state.pii as PiiProtectionSettings).scopes).toEqual(payload.scopes);
});

test("PUT /tenant/settings/pii keeps stored scope keys that the save does not name, as stored", async () => {
  const stored = { ...VALID_PII_PAYLOAD, scopes: { chatPrompts: false, uploads: false, retiredImports: false, partnerImports: false, junk: "kept" } };
  const { response, state } = await putPii({ payload: VALID_PII_PAYLOAD, stored, piiImportScopes: registryWith("partnerImports", "partner_import") });
  expect(response.statusCode).toBe(200);
  const saved = { chatPrompts: true, uploads: true, retiredImports: false, partnerImports: false, junk: "kept" };
  expect((state.pii as PiiProtectionSettings).scopes).toEqual(saved);
  expect(state.audits.at(-1)?.payload).toEqual({ piiProtection: { ...VALID_PII_PAYLOAD, scopes: saved }, revision: 1, checked: false, weakerFields: [] });
  expect(response.json().piiProtection.scopes).toEqual({ chatPrompts: true, uploads: true, partnerImports: false });
});

test("PUT /tenant/settings/pii stores a valid payload", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: VALID_PII_PAYLOAD
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.ok).toBe(true);
  expect(body.piiProtection).toEqual(VALID_PII_PAYLOAD);
  expect(state.pii).toEqual(VALID_PII_PAYLOAD);
  // A save with no revision is the unchecked compatibility path.
  expect(state.audits).toEqual([expect.objectContaining({
    type: "tenant.pii_protection.updated",
    payload: { piiProtection: VALID_PII_PAYLOAD, revision: 1, checked: false, weakerFields: [] }
  })]);
});

test("GET /tenant returns the PII settings revision", async () => {
  const { store } = makeFakeOrgSettingsStore({ piiRevision: 7 });
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store });

  const response = await app.inject({ method: "GET", url: "/tenant" });
  expect(response.statusCode).toBe(200);
  expect(response.json().settings.piiProtectionRevision).toBe(7);
});

// One store for a GET and a PUT, as the admin form uses them.
async function piiFormRoundTrip(options: { stored: unknown; storedRevision?: number; role?: Role }) {
  const { store, state } = makeFakeOrgSettingsStore({ pii: options.stored, piiRevision: options.storedRevision });
  const app = makeOrgSettingsApp(options.role ?? "admin");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store });
  await app.ready();
  const read = async () => {
    const response = await app.inject({ method: "GET", url: "/tenant" });
    expect(response.statusCode).toBe(200);
    return response.json().settings;
  };
  const save = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/tenant/settings/pii", payload });
  return { state, read, save };
}

const MALFORMED_PII = { ...VALID_PII_PAYLOAD, mode: "sometimes", scopes: { chatPrompts: true, uploads: "yes", retiredImports: false } };

test.each(["owner", "admin"] as const)("GET /tenant sends the PII policy health to an %s", async (role) => {
  const { read } = await piiFormRoundTrip({ stored: MALFORMED_PII, role });
  const settings = await read();
  expect(settings.piiProtectionHealth).toEqual({ state: "error", reasons: ["mode_invalid", "scope_invalid"], fields: ["mode", "scopes.uploads"] });
  // Safe values, not stored ones.
  expect(settings.piiProtection).toEqual({ ...VALID_PII_PAYLOAD, mode: "block", scopes: { chatPrompts: true, uploads: true } });
});

test("GET /tenant sends no PII policy health to a member", async () => {
  const { read } = await piiFormRoundTrip({ stored: MALFORMED_PII, role: "member" });
  expect(await read()).not.toHaveProperty("piiProtectionHealth");
});

test("an admin repairs a malformed stored policy with a save of the shown settings, unchanged", async () => {
  const { state, read, save } = await piiFormRoundTrip({ stored: MALFORMED_PII, storedRevision: 2 });
  const shown = await read();

  const response = await save({ ...shown.piiProtection, expectedRevision: shown.piiProtectionRevision });

  expect(response.statusCode).toBe(200);
  const after = await read();
  expect(after.piiProtectionHealth).toEqual({ state: "ok", reasons: [], fields: [] });
  expect(after.piiProtection).toEqual(shown.piiProtection);
  expect(after.piiProtectionRevision).toBe(3);
  // A scope key that no import source registered stays as stored.
  expect((state.pii as PiiProtectionSettings).scopes).toEqual({ chatPrompts: true, uploads: true, retiredImports: false });
});

test("a repair save with no change keeps protection on when the stored policy is on with mode Off", async () => {
  const { state, read, save } = await piiFormRoundTrip({ stored: { ...VALID_PII_PAYLOAD, mode: "off" }, storedRevision: 1 });
  const shown = await read();
  expect(shown.piiProtectionHealth).toEqual({ state: "error", reasons: ["mode_off_while_enabled"], fields: ["mode"] });

  const response = await save({ ...shown.piiProtection, expectedRevision: shown.piiProtectionRevision });

  expect(response.statusCode).toBe(200);
  expect(state.pii).toMatchObject({ enabled: true, mode: "block" });
  expect((await read()).piiProtectionHealth).toEqual({ state: "ok", reasons: [], fields: [] });
});

test("a stored policy with unknown keys saves unchanged, and the save removes the keys", async () => {
  const stored = {
    ...VALID_PII_PAYLOAD,
    futureOption: true,
    provider: { ...VALID_PII_PAYLOAD.provider, endpoint: "https://pii.example.test" },
    actions: { ...VALID_PII_PAYLOAD.actions, notify: "all" },
    detectors: { ...VALID_PII_PAYLOAD.detectors, threshold: 0.5 }
  };
  const { state, read, save } = await piiFormRoundTrip({ stored, storedRevision: 2 });
  const shown = await read();
  expect(shown.piiProtectionHealth.state).toBe("ok");

  const response = await save({ ...shown.piiProtection, expectedRevision: shown.piiProtectionRevision });

  expect(response.statusCode).toBe(200);
  expect(shown.piiProtection).toEqual(VALID_PII_PAYLOAD);
  expect(state.pii).toEqual(VALID_PII_PAYLOAD);
  expect((await read()).piiProtectionHealth).toEqual({ state: "ok", reasons: [], fields: [] });
});

test("PUT /tenant/settings/pii with the stored revision saves and returns the next revision", async () => {
  const stored = { ...VALID_PII_PAYLOAD, enabled: false, mode: "off" };
  const { response, state } = await putPii({ payload: { ...VALID_PII_PAYLOAD, expectedRevision: 4 }, stored, storedRevision: 4 });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, piiProtection: VALID_PII_PAYLOAD, piiProtectionRevision: 5 });
  // The revision is not part of the stored policy. The audit event records
  // the new revision and that the save was checked.
  expect(state.pii).toEqual(VALID_PII_PAYLOAD);
  expect(state.piiRevision).toBe(5);
  expect(state.audits).toEqual([expect.objectContaining({
    type: "tenant.pii_protection.updated",
    payload: { piiProtection: VALID_PII_PAYLOAD, revision: 5, checked: true, weakerFields: [] }
  })]);
});

test("PUT /tenant/settings/pii with an older revision returns 409 and writes nothing", async () => {
  const stored = { ...VALID_PII_PAYLOAD, enabled: false, mode: "off" };
  const { response, state } = await putPii({ payload: { ...VALID_PII_PAYLOAD, expectedRevision: 3 }, stored, storedRevision: 4 });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "pii_settings_conflict", message: expect.any(String) });
  expect(state.pii).toEqual(stored);
  expect(state.piiRevision).toBe(4);
  expect(state.audits).toEqual([]);
});

// Compatibility path: the deployed frontend and older rollback frontends send no revision.
test("PUT /tenant/settings/pii without a revision saves with no check", async () => {
  const stored = { ...VALID_PII_PAYLOAD, enabled: false, mode: "off" };
  const { response, state } = await putPii({ payload: VALID_PII_PAYLOAD, stored, storedRevision: 4 });

  expect(response.statusCode).toBe(200);
  expect(response.json().piiProtectionRevision).toBe(5);
  expect(state.pii).toEqual(VALID_PII_PAYLOAD);
  expect(state.audits).toHaveLength(1);
});

// Step-up for a PII save that makes the protection weaker
// (services/pii/pii-weakening.ts), with the real DataRouteControl and step-up
// store: a local session needs a token, the owner notice names the weaker
// fields, and the revision check of the save keeps working with the resend.

const PII_ON = { ...VALID_PII_PAYLOAD, mode: "block" as const };
const PII_OFF = { ...VALID_PII_PAYLOAD, enabled: false, mode: "off" as const };

async function piiStepUpApp(options: { stored: unknown; storedRevision: number; session?: "local" | "workos" }) {
  const { store, state } = makeFakeOrgSettingsStore({ pii: options.stored, piiRevision: options.storedRevision });
  const redis = new FakeRefreshTokenRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
  const stepUp = new StepUpStore(redis);
  const consume = vi.spyOn(stepUp, "consume");
  const notices: DataSettingChange[] = [];
  const dataRoutes = new DataRouteControl({
    authMode: "jwt",
    localAuth: { stepUp, refreshTokens, mfa: { hasSecondFactor: async () => false } } as unknown as LocalAuth,
    ownerNotices: { async queueOwnerNotice(_client, _tenantId, input) { notices.push(input.change); return 1; } }
  });
  const app = makeOrgSettingsApp("owner", options.session === "workos"
    ? { authSource: "workos", familyId: "family-1" }
    : { authSource: "local", familyId: "family-1", securityVersion: 1 });
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes, afterSecurityChange: IGNORE_SECURITY_CHANGE, db: makeTenantsDb() as never, tenantOrgSettings: store });
  await app.ready();
  const token = async () => (await stepUp.create(
    { userId: "user-1", tenantId: "tenant-1", familyId: "family-1", securityVersion: 1, action: "tenant.pii_settings" }, ["pwd"])).token;
  const save = (payload: Record<string, unknown>, stepUpToken?: string) => app.inject({
    method: "PUT", url: "/tenant/settings/pii", payload, headers: stepUpToken ? { "x-step-up": stepUpToken } : {}
  });
  return { state, consume, notices, token, save };
}

test("PUT /tenant/settings/pii: turning protection off needs step-up; the resend with the same revision saves and notifies the owners", async () => {
  const { state, notices, token, save } = await piiStepUpApp({ stored: PII_ON, storedRevision: 4 });

  const refused = await save({ ...PII_OFF, expectedRevision: 4 });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ error: "step_up_required", action: "tenant.pii_settings" });
  expect(state).toMatchObject({ pii: PII_ON, piiRevision: 4, audits: [] });
  expect(notices).toEqual([]);

  // The browser sends the same request again, with the token.
  const saved = await save({ ...PII_OFF, expectedRevision: 4 }, await token());
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().piiProtectionRevision).toBe(5);
  expect(state.audits).toEqual([expect.objectContaining({ payload: expect.objectContaining({ weakerFields: ["Protection", "Mode"] }) })]);
  // Field names only: the notice has no value of the policy.
  expect(notices).toEqual([{ setting: "pii_protection", fields: ["Protection", "Mode"] }]);
  expect(JSON.stringify(notices)).not.toContain("meta/llama-guard");
});

test("PUT /tenant/settings/pii: a lower mode or a scope turned off needs step-up", async () => {
  for (const payload of [{ ...PII_ON, mode: "detect" }, { ...PII_ON, scopes: { chatPrompts: true, uploads: false } }]) {
    const { state, save } = await piiStepUpApp({ stored: PII_ON, storedRevision: 4 });
    expect((await save({ ...payload, expectedRevision: 4 })).statusCode).toBe(403);
    expect(state.piiRevision).toBe(4);
  }
});

test("PUT /tenant/settings/pii: a stale save answers 409 before step-up and does not spend the token", async () => {
  const { state, consume, notices, token, save } = await piiStepUpApp({ stored: PII_ON, storedRevision: 4 });
  const stepUpToken = await token();

  const stale = await save({ ...PII_OFF, expectedRevision: 3 }, stepUpToken);
  expect(stale.statusCode).toBe(409);
  expect(consume).not.toHaveBeenCalled();
  expect(state.piiRevision).toBe(4);

  // The token still works for a save that names the stored revision.
  expect((await save({ ...PII_OFF, expectedRevision: 4 }, stepUpToken)).statusCode).toBe(200);
  expect(notices).toHaveLength(1);
});

test("PUT /tenant/settings/pii: another save between the refusal and the resend makes the resend answer 409", async () => {
  const { state, token, save } = await piiStepUpApp({ stored: PII_ON, storedRevision: 4 });
  expect((await save({ ...PII_OFF, expectedRevision: 4 })).statusCode).toBe(403);
  // Another admin saves first.
  state.piiRevision = 5;
  const resend = await save({ ...PII_OFF, expectedRevision: 4 }, await token());
  expect(resend.statusCode).toBe(409);
  expect(state.pii).toEqual(PII_ON);
});

// The legacy scope key is accepted without its overlay and kept as stored. A
// save that turns it off while the overlay is absent must still count, or
// the overlay would come back with its imports unscanned and nobody told.
test("PUT /tenant/settings/pii: turning off a legacy scope while its overlay is absent needs step-up and notifies the owners", async () => {
  const stored = { ...PII_ON, scopes: { chatPrompts: true, uploads: true, microsoftImports: true } };
  const payload = { ...PII_ON, scopes: { chatPrompts: true, uploads: true, microsoftImports: false }, expectedRevision: 4 };
  const overlayPresent = registryWith("microsoftImports", "microsoft_import");

  // A local session with no step-up: refused; with the overlay back, the imports are still scanned.
  const local = await piiStepUpApp({ stored, storedRevision: 4 });
  expect((await local.save(payload)).statusCode).toBe(403);
  expect(resolvePiiPolicy(local.state.pii, overlayPresent).settings.scopes.microsoftImports).toBe(true);

  // A WorkOS session: saved, and the owners get the notice that names the scope.
  const workos = await piiStepUpApp({ stored, storedRevision: 4, session: "workos" });
  expect((await workos.save(payload)).statusCode).toBe(200);
  expect(resolvePiiPolicy(workos.state.pii, overlayPresent).settings.scopes.microsoftImports).toBe(false);
  expect(workos.notices).toEqual([{ setting: "pii_protection", fields: ["Scanned content: microsoftImports"] }]);
});

test("PUT /tenant/settings/pii: a stronger save needs no step-up and sends no notice", async () => {
  const { consume, notices, save } = await piiStepUpApp({ stored: { ...PII_ON, mode: "detect" }, storedRevision: 4 });
  expect((await save({ ...PII_ON, expectedRevision: 4 })).statusCode).toBe(200);
  expect(consume).not.toHaveBeenCalled();
  expect(notices).toEqual([]);
});

test("PUT /tenant/settings/pii: a WorkOS session turns protection off with no step-up, and the owners get the notice", async () => {
  const { consume, notices, save } = await piiStepUpApp({ stored: PII_ON, storedRevision: 4, session: "workos" });
  expect((await save({ ...PII_OFF, expectedRevision: 4 })).statusCode).toBe(200);
  expect(consume).not.toHaveBeenCalled();
  expect(notices).toEqual([{ setting: "pii_protection", fields: ["Protection", "Mode"] }]);
});

test.each([-1, 1.5, "4", null])("PUT /tenant/settings/pii rejects the revision %j", async (expectedRevision) => {
  const { response, state } = await putPii({ payload: { ...VALID_PII_PAYLOAD, expectedRevision }, storedRevision: 4 });

  expect(response.statusCode).toBe(400);
  expect(response.json().details).toEqual([expect.objectContaining({ path: "expectedRevision" })]);
  expect(state.piiRevision).toBe(4);
  expect(state.audits).toEqual([]);
});

test("PUT /tenant/settings/pii rejects invalid enum", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { ...VALID_PII_PAYLOAD, mode: "bogus" }
  });

  expect(response.statusCode).toBe(400);
  const body = response.json();
  expect(body.error).toBe("validation_error");
  expect(Array.isArray(body.details)).toBeTruthy();
  expect(body.details.some((d: { path: string }) => d.path === "mode")).toBeTruthy();
  expect(typeof body.message).toBe("string");
  expect(body.message).toMatch(/mode/);
});

test("PUT /tenant/settings/pii rejects enabled+off combination", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { ...VALID_PII_PAYLOAD, enabled: true, mode: "off" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("invalid_combination");
});

test("PUT /tenant/settings/pii returns 403 for member role", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp("member");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: VALID_PII_PAYLOAD
  });

  expect(response.statusCode).toBe(403);
});

test("PUT /tenant/settings/pii rejects missing required fields", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { mode: "detect" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("validation_error");
});

// ---------------------------------------------------------------------------
// PUT /tenant (owner only)
// ---------------------------------------------------------------------------

async function renameTenant(role: Role, payload: Record<string, unknown>, previousName = "Old Name") {
  const pool = new FakePool()
    .onQuery(/SELECT tenant_name FROM tenants/, () => ({ rows: [{ tenant_name: previousName }], rowCount: 1 }))
    .onQuery(/UPDATE tenants SET/, (_text, values) => ({
      rows: [{ tenant_id: values.at(-1), tenant_name: values[0], slug: "test", plan: "free", updated_at: "2026-10-03T00:00:00.000Z" }],
      rowCount: 1
    }))
    .onQuery(/INSERT INTO audit_events/, () => ({ rows: [], rowCount: 1 }));
  // Records each owner notice and the statements that ran before it, so a
  // test can check that the notice is in the rename's transaction.
  const notices: Array<{ change: unknown; statementsBefore: string[] }> = [];
  const dataRoutes = {
    requireStepUp: async () => true,
    writeWithStepUpIfWeaker: async <T>(_request: unknown, _reply: unknown, _route: unknown, write: (allowWeaker: boolean) => Promise<T>) =>
      ({ saved: await write(true) }),
    ownerNotice: (_request: unknown, change: unknown) => async () => {
      notices.push({ change, statementsBefore: pool.queries.map((query) => query.text.trim().split(/\s+/).slice(0, 3).join(" ")) });
    }
  };
  const app = makeOrgSettingsApp(role);
  onTestFinished(async () => {
    await app.close();
  });
  await registerTenantRoutes(app, { dataRoutes, afterSecurityChange: IGNORE_SECURITY_CHANGE, db: pool.asPool(), tenantOrgSettings: makeFakeOrgSettingsStore().store });
  const response = await app.inject({ method: "PUT", url: "/tenant", payload });
  const updates = pool.queries.filter((query) => query.text.includes("UPDATE tenants"));
  const audits = pool.queries.filter((query) => query.text.includes("INSERT INTO audit_events"));
  return { response, updates, audits, notices, statements: pool.queries.map((query) => query.text.trim()) };
}

test("PUT /tenant: an owner renames their own tenant, whatever tenant the body names", async () => {
  const { response, updates } = await renameTenant("owner", { tenantName: "  Acme Inc.  ", tenantId: "tenant-2" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ tenant_id: "tenant-1", tenant_name: "Acme Inc." });
  expect(updates).toHaveLength(1);
  expect(updates[0]!.values).toEqual(["Acme Inc.", "tenant-1"]);
});

test.each(["admin", "member"] as const)("PUT /tenant: refuses a tenant %s before any write", async (role) => {
  const { response, updates } = await renameTenant(role, { tenantName: "Acme Inc." });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "forbidden", message: "Insufficient permissions" });
  expect(updates).toEqual([]);
});

test("PUT /tenant: answers no_updates when the body changes nothing", async () => {
  const { response, updates } = await renameTenant("owner", {});

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "no_updates" });
  expect(updates).toEqual([]);
});

// The name appears in every owner notice. A rename is a change that owners
// must see, and a name must not pass for a link or an address.
test("PUT /tenant: a rename writes an audit event and the owner notice in its transaction", async () => {
  const { response, audits, notices, statements } = await renameTenant("owner", { tenantName: "Acme Inc." });

  expect(response.statusCode).toBe(200);
  expect(audits).toHaveLength(1);
  expect(audits[0]!.values).toEqual(expect.arrayContaining(["tenant.renamed", JSON.stringify({ previousName: "Old Name", tenantName: "Acme Inc." })]));
  expect(notices).toEqual([{ change: { setting: "organization_name", previousName: "Old Name" }, statementsBefore: expect.any(Array) }]);
  // BEGIN, the lock, the rename, the audit event, then the notice; COMMIT after it.
  expect(notices[0]!.statementsBefore.at(-1)).toBe("INSERT INTO audit_events");
  expect(statements.indexOf("COMMIT")).toBeGreaterThan(statements.findIndex((text) => text.startsWith("INSERT INTO audit_events")));
});

test("PUT /tenant: the same name again writes no event and sends no notice", async () => {
  const { response, audits, notices } = await renameTenant("owner", { tenantName: "Acme Inc." }, "Acme Inc.");

  expect(response.statusCode).toBe(200);
  expect(audits).toEqual([]);
  expect(notices).toEqual([]);
});

test.each([
  ["a link", "Acme https://evil.example"],
  ["a link without a scheme", "Acme www.evil.example"],
  ["an email address", "support@evil.example"],
  ["upper case", "Acme WWW.EVIL.EXAMPLE"]
])("PUT /tenant: refuses a name with %s before any write", async (_case, tenantName) => {
  const { response, updates, notices } = await renameTenant("owner", { tenantName });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: "invalid_tenant_name", message: expect.stringContaining("plain organization name") });
  expect(updates).toEqual([]);
  expect(notices).toEqual([]);
});

test.each([
  ["a blank name", { tenantName: "   " }],
  ["a name over 200 characters", { tenantName: "x".repeat(201) }]
])("PUT /tenant: rejects %s before any write", async (_case, payload) => {
  const { response, updates } = await renameTenant("owner", payload);

  expect(response.statusCode).toBe(400);
  expect(response.json().error).not.toBe("no_updates");
  expect(updates).toEqual([]);
});

