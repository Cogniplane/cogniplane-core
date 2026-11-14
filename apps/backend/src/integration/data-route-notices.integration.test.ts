// The owner notice of a data route (a tenant setting that changes where the
// tenant's data goes), against a real Postgres with the production roles:
// every owner with an address gets one, WorkOS owners too (migration 082 moved
// the outbox key to tenant_memberships); it commits with the change and rolls
// back with it; it never carries the value. Migration 082 itself: rows of
// accounts that are no longer members go, and a removed member's rows follow
// the membership.

import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { decrypt, encrypt } from "../lib/crypto-utils.js";
import { withTenantScope } from "../lib/db.js";
import { registerAdminIntegrationsRoutes } from "../routes/admin/admin-integrations-routes.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { registerAdminPolicyRoutes } from "../routes/admin/admin-policy-routes.js";
import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { PolicyService } from "../services/policy/policy-service.js";
import { ALLOW_WEAKER, PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";
import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { AuditEventStore } from "../services/audit-event-store.js";
import { DataRouteControl } from "../services/data-route-control.js";
import { getIntegrationDescriptor, registerIntegration } from "../services/integrations/integration-registry.js";
import { type IntegrationStateRecord, IntegrationStateStore } from "../services/integrations/integration-state-store.js";
import { MailOutbox } from "../services/mail/mail-outbox.js";
import type { OutgoingMail } from "../services/mail/mail-sender.js";
import { type DataSettingChange, OWNER_NOTICE_MAX_CHANGES, SETTING_CHANGE_SUBJECT } from "../services/mail/setting-change-notices.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const SECRET = "data-route-notices-integration-secret-32-chars";
const PROVIDER_KEY = "sk-integration-secret-provider-key-0001";
const WEB_SEARCH: DataSettingChange = { setting: "tenant_settings", fields: ["Web search"] };

type Person = { userId: string; email: string | null; name: string; role: "owner" | "admin" | "member" };

/** A WorkOS tenant: two owners with an address, one owner without, an admin, and a member. */
async function workosTenant() {
  const tenantId = `tenant-${randomUUID()}`;
  const people: Person[] = [
    { userId: `owner-a-${randomUUID()}`, email: `${randomUUID()}@example.test`, name: "Olive Owner", role: "owner" },
    { userId: `owner-b-${randomUUID()}`, email: `${randomUUID()}@example.test`, name: "Otto Owner", role: "owner" },
    { userId: `owner-c-${randomUUID()}`, email: null, name: "Nameless Owner", role: "owner" },
    { userId: `admin-${randomUUID()}`, email: `${randomUUID()}@example.test`, name: "Ada Admin", role: "admin" },
    { userId: `member-${randomUUID()}`, email: `${randomUUID()}@example.test`, name: "Max Member", role: "member" }
  ];
  const db = superuserPool();
  await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'Acme Data', $1)`, [tenantId]);
  for (const person of people) {
    await db.query(`INSERT INTO users (user_id, email, display_name, auth_source) VALUES ($1, $2, $3, 'workos')`,
      [person.userId, person.email, person.name]);
    await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
      [tenantId, person.userId, person.role]);
  }
  return { tenantId, people, owner: people[0]!, admin: people[3]! };
}

async function noticesOf(tenantId: string): Promise<Array<{ userId: string; mail: OutgoingMail; expiresAt: Date }>> {
  const rows = await superuserPool().query<{ user_id: string; message_encrypted: string; expires_at: Date }>(
    `SELECT user_id, message_encrypted, expires_at FROM email_outbox
     WHERE tenant_id = $1 AND kind = 'tenant_setting_changed' AND message_encrypted IS NOT NULL ORDER BY user_id`,
    [tenantId]
  );
  return rows.rows.map((row) => ({
    userId: row.user_id,
    mail: JSON.parse(decrypt(row.message_encrypted, SECRET)) as OutgoingMail,
    expiresAt: row.expires_at
  }));
}

function control(): DataRouteControl {
  return new DataRouteControl({ authMode: "jwt", ownerNotices: new MailOutbox({ secret: SECRET }) });
}

/** What ownerNotice reads from a request: the caller. */
function requestOf(tenantId: string, userId: string): FastifyRequest {
  return { auth: { tenantId, userId } } as FastifyRequest;
}

describe.skipIf(!adminDatabaseUrl())("data route owner notices", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });
  afterEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a provider key change from a WorkOS session emails every owner with an address, with no key", async () => {
    const t = await workosTenant();
    const app = Fastify();
    await app.register(cookie);
    app.addHook("preHandler", async (request) => {
      request.auth = {
        userId: t.owner.userId, tenantId: t.tenantId, role: "owner", isAdmin: true, email: t.owner.email!,
        session: { authSource: "workos", familyId: "family-1" }
      };
    });
    await registerTenantRoutes(app, {
      db: appPool(),
      tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET),
      afterSecurityChange: IGNORE_SECURITY_CHANGE,
      dataRoutes: control()
    });
    await app.ready();
    try {
      // No step-up from a WorkOS session: the notice is the check.
      const res = await app.inject({ method: "PUT", url: "/tenant/settings", payload: { provider: "openai", apiKey: PROVIDER_KEY } });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await app.close();
    }

    const notices = await noticesOf(t.tenantId);
    const owners = t.people.filter((person) => person.role === "owner" && person.email);
    expect(notices.map((notice) => notice.userId)).toEqual(owners.map((owner) => owner.userId).sort());
    for (const notice of notices) {
      const owner = owners.find((person) => person.userId === notice.userId)!;
      expect(notice.mail.to).toBe(owner.email);
      // Fixed subject and first sentence; who, which setting, and when in labelled fields.
      expect(notice.mail.subject).toBe(SETTING_CHANGE_SUBJECT);
      const lines = notice.mail.text.split("\n");
      expect(lines.slice(0, 3)).toEqual(["Hello,", "", `${SETTING_CHANGE_SUBJECT}.`]);
      for (const line of ["Organization: Acme Data", `Organization ID: ${t.tenantId}`, "Setting: Provider API key", "Provider: OpenAI",
        "Change: A new key was saved.", `Changed by: Olive Owner (${t.owner.email})`]) {
        expect(lines, line).toContain(line);
      }
      expect(notice.mail.text).toMatch(/^Time: \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC$/m);
      expect(notice.expiresAt.getTime()).toBeGreaterThan(Date.now());
      for (const body of [notice.mail.text, notice.mail.html, notice.mail.subject]) {
        expect(body).not.toContain(PROVIDER_KEY);
        expect(body).not.toMatch(/https?:|<a\b/i);
      }
    }
    // The audit event of the change committed too, with no key.
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.provider_key.updated'`, [t.tenantId]);
    expect(audit.rows).toEqual([{ payload: { provider: "openai", keySet: true } }]);
  });

  test("the notice rolls back with the change", async () => {
    const t = await workosTenant();
    await expect(withTenantScope(appPool(), t.tenantId, async (client) => {
      await AuditEventStore.createInTransaction(client, {
        tenantId: t.tenantId, sessionId: null, userId: t.admin.userId, type: "tenant.integration.updated", payload: {},
        alsoInTransaction: control().ownerNotice(requestOf(t.tenantId, t.admin.userId), { setting: "tenant_settings", fields: ["Web search"] })
      });
      expect((await client.query(`SELECT 1 FROM email_outbox WHERE tenant_id = $1`, [t.tenantId])).rowCount).toBe(2);
      throw new Error("the change fails after its audit event");
    })).rejects.toThrow("the change fails");

    expect(await noticesOf(t.tenantId)).toEqual([]);
  });

  test("an integration change commits its audit event and the notice in the store's transaction", async () => {
    const t = await workosTenant();
    await new IntegrationStateStore(appPool()).upsert(t.tenantId, "github", { readsEnabled: true, updatedBy: t.admin.userId }, (saved) => ({
      tenantId: t.tenantId, sessionId: null, userId: t.admin.userId, type: "tenant.integration.updated",
      payload: { integrationId: saved.integrationId, readsEnabled: saved.readsEnabled },
      alsoInTransaction: control().ownerNotice(requestOf(t.tenantId, t.admin.userId), {
        setting: "integration", integrationName: "GitHub", fields: ["Read access turned on"]
      })
    }));

    const notices = await noticesOf(t.tenantId);
    expect(notices).toHaveLength(2);
    for (const line of ["Setting: Integration settings", "Integration: GitHub", "Changed fields: Read access turned on", `Changed by: Ada Admin (${t.admin.email})`]) {
      expect(notices[0]!.mail.text.split("\n"), line).toContain(line);
    }
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.integration.updated'`, [t.tenantId]);
    expect(audit.rows).toEqual([{ payload: { integrationId: "github", readsEnabled: true } }]);
  });

  // A Policy Center change and a PII save send the notice only when they
  // make a control weaker, through the real routes and stores. A WorkOS
  // session gives no step-up, so the notice is the only check.
  test("a Policy Center change emails the owners only when it makes the policy weaker", async () => {
    const t = await workosTenant();
    const rules = new PolicyRuleStore(appPool());
    const decisions = new PolicyDecisionStore(appPool());
    const block = await rules.create(t.tenantId,
      { name: "Block exports", effect: "block", conditions: { toolNames: ["export_customers"] } }, t.admin.userId, ALLOW_WEAKER);
    const app = Fastify();
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: t.admin.userId, tenantId: t.tenantId, role: "admin", isAdmin: true,
        session: { authSource: "workos", familyId: "family-1" } };
    });
    await registerAdminPolicyRoutes(app, {
      policyRules: rules, policyDecisions: decisions,
      policyService: new PolicyService({ rules, decisions }),
      dataRoutes: control()
    });
    await app.ready();
    try {
      // Not weaker: a rename, and a new block rule.
      expect((await app.inject({ method: "PATCH", url: `/admin/policy/rules/${block.ruleId}`,
        payload: { name: "Block customer exports", expectedRevision: block.revision } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/admin/policy/rules", payload: { name: "Block deletes", effect: "block", conditions: { toolNames: ["delete_customers"] } } })).statusCode).toBe(200);
      expect(await noticesOf(t.tenantId)).toEqual([]);
      // Weaker: the export block rule removed.
      expect((await app.inject({ method: "DELETE", url: `/admin/policy/rules/${block.ruleId}` })).statusCode).toBe(204);
    } finally {
      await app.close();
    }

    const notices = await noticesOf(t.tenantId);
    expect(notices).toHaveLength(2);
    for (const line of ["Setting: Policy Center rules", "Rule: Block customer exports", `Rule ID: ${block.ruleId}`,
      "Change: A rule was removed. Some tool calls now get a less strict result."]) {
      expect(notices[0]!.mail.text.split("\n"), line).toContain(line);
    }
    const audit = await superuserPool().query<{ event_type: string; payload: { weaker: boolean } }>(
      `SELECT event_type, payload FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'admin.policy_rule.%' ORDER BY created_at, event_type`,
      [t.tenantId]);
    expect(audit.rows.map((row) => [row.event_type, row.payload.weaker]).sort()).toEqual([
      ["admin.policy_rule.created", false], ["admin.policy_rule.deleted", true], ["admin.policy_rule.updated", false]
    ]);
  });

  // Admin A edits a rule from an old form while admin B has made it stricter.
  // The save names the revision that A loaded. The route answers 409 before
  // it classifies the change: no step-up prompt, no change, no audit event, no
  // owner notice and no cache drop. A save from the current revision works.
  test("a Policy Center save from an older revision answers 409 and writes nothing", async () => {
    const t = await workosTenant();
    const rules = new PolicyRuleStore(appPool());
    const decisions = new PolicyDecisionStore(appPool());
    const policyService = new PolicyService({ rules, decisions });
    const invalidate = vi.spyOn(policyService, "invalidate");
    const loaded = await rules.create(t.tenantId,
      { name: "Allow exports", effect: "allow", enabled: false, conditions: { toolNames: ["export_customers"] } }, t.admin.userId, ALLOW_WEAKER);
    let session: NonNullable<FastifyRequest["auth"]["session"]> = { authSource: "workos", familyId: "family-1" };
    const app = Fastify();
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: t.admin.userId, tenantId: t.tenantId, role: "admin", isAdmin: true, session };
    });
    await registerAdminPolicyRoutes(app, { policyRules: rules, policyDecisions: decisions, policyService, dataRoutes: control() });
    await app.ready();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/admin/policy/rules/${loaded.ruleId}`, payload });
    // A's old form: the old status and effect, with a new name.
    const staleForm = { expectedRevision: loaded.revision, name: "Allow customer exports", enabled: false, effect: "allow",
      conditions: { toolNames: ["export_customers"] }, reason: null };
    try {
      // B turns the rule on as a block rule.
      const stricter = await patch({ expectedRevision: loaded.revision, enabled: true, effect: "block" });
      expect(stricter.statusCode, stricter.body).toBe(200);
      expect(stricter.json().rule).toMatchObject({ enabled: true, effect: "block", revision: 2 });
      invalidate.mockClear();

      // A local session would need step-up for a weaker change. The stale save is refused first.
      session = { authSource: "local", familyId: "family-1" };
      const fromLocal = await patch(staleForm);
      expect(fromLocal.statusCode, fromLocal.body).toBe(409);
      expect(fromLocal.json()).toEqual({ error: "policy_rule_conflict", message: expect.any(String) });
      // A WorkOS session gets no step-up: the revision is the only check.
      session = { authSource: "workos", familyId: "family-1" };
      expect((await patch(staleForm)).statusCode).toBe(409);
      expect(invalidate).not.toHaveBeenCalled();
      // No revision: the body is refused.
      const { expectedRevision: _omitted, ...withoutRevision } = staleForm;
      expect((await patch(withoutRevision)).statusCode).toBe(400);

      // From the current revision, the same rename commits and gives the next revision.
      const fresh = await patch({ expectedRevision: 2, name: "Block customer exports" });
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(fresh.json().rule).toMatchObject({ name: "Block customer exports", enabled: true, effect: "block", revision: 3 });
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }

    expect(await rules.get(t.tenantId, loaded.ruleId)).toMatchObject({ name: "Block customer exports", enabled: true, effect: "block", revision: 3 });
    // B's change was not weaker: no notice. The refused saves wrote none.
    expect(await noticesOf(t.tenantId)).toEqual([]);
    const audit = await superuserPool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'admin.policy_rule.updated' ORDER BY created_at`, [t.tenantId]);
    expect(audit.rows.map((row) => row.payload)).toEqual([
      { ruleId: loaded.ruleId, effect: "block", enabled: true, revision: 2, weaker: false },
      { ruleId: loaded.ruleId, effect: "block", enabled: true, revision: 3, weaker: false }
    ]);
  });

  test("a Policy Center save cannot reach a rule of another tenant", async () => {
    const t = await workosTenant();
    const other = await workosTenant();
    const rules = new PolicyRuleStore(appPool());
    const decisions = new PolicyDecisionStore(appPool());
    const theirs = await rules.create(other.tenantId, { name: "Block exports", effect: "block" }, other.admin.userId, ALLOW_WEAKER);
    const app = Fastify();
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: t.admin.userId, tenantId: t.tenantId, role: "admin", isAdmin: true,
        session: { authSource: "workos", familyId: "family-1" } };
    });
    await registerAdminPolicyRoutes(app, {
      policyRules: rules, policyDecisions: decisions,
      policyService: new PolicyService({ rules, decisions }),
      dataRoutes: control()
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "PATCH", url: `/admin/policy/rules/${theirs.ruleId}`,
        payload: { expectedRevision: theirs.revision, enabled: false } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "policy_rule_not_found" });
    } finally {
      await app.close();
    }
    expect(await rules.get(other.tenantId, theirs.ruleId)).toEqual(theirs);
    expect(await noticesOf(other.tenantId)).toEqual([]);
  });

  test("a PII save emails the owners with the weaker field names only when it makes the protection weaker", async () => {
    const t = await workosTenant();
    const settings = new TenantOrgSettingsStore(appPool(), SECRET);
    const on = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" as const, provider: { type: "openai-compatible" as const, model: "pii-model-secret-name" } };
    await settings.setPiiProtection(t.tenantId, on, PII_SAVE_ALLOWED);
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: t.admin.userId, tenantId: t.tenantId, role: "admin", isAdmin: true,
        session: { authSource: "workos", familyId: "family-1" } };
    });
    await registerTenantRoutes(app, { db: appPool(), tenantOrgSettings: settings, afterSecurityChange: IGNORE_SECURITY_CHANGE, dataRoutes: control() });
    await app.ready();
    try {
      // The same policy again: not weaker.
      expect((await app.inject({ method: "PUT", url: "/tenant/settings/pii", payload: { ...on, expectedRevision: 1 } })).statusCode).toBe(200);
      expect(await noticesOf(t.tenantId)).toEqual([]);
      // Uploads no longer scanned.
      const res = await app.inject({ method: "PUT", url: "/tenant/settings/pii",
        payload: { ...on, scopes: { chatPrompts: true, uploads: false }, expectedRevision: 2 } });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await app.close();
    }

    const notices = await noticesOf(t.tenantId);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.mail.text.split("\n")).toContain("Weaker fields: Scanned content: Uploads");
    expect(notices[0]!.mail.text).not.toContain("pii-model-secret-name");
  });

  test("a row belongs to a member: none for a non-member, and a removed member's rows go with the membership", async () => {
    const t = await workosTenant();
    await withTenantScope(appPool(), t.tenantId, (client) =>
      new MailOutbox({ secret: SECRET }).queueOwnerNotice(client, t.tenantId, { actorUserId: t.owner.userId, change: WEB_SEARCH }));
    expect(await noticesOf(t.tenantId)).toHaveLength(2);

    const outsider = `outsider-${randomUUID()}`;
    await superuserPool().query(`INSERT INTO users (user_id, email, auth_source) VALUES ($1, 'outsider@example.test', 'workos')`, [outsider]);
    await expect(superuserPool().query(
      `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, status, expires_at)
       VALUES ($1, $2, $3, 'tenant_setting_changed', 'sent', now() + interval '1 day')`,
      [t.tenantId, randomUUID(), outsider]
    )).rejects.toMatchObject({ constraint: "email_outbox_membership_fkey" });

    const second = t.people[1]!;
    await superuserPool().query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [t.tenantId, second.userId]);
    expect((await noticesOf(t.tenantId)).map((notice) => notice.userId)).toEqual([t.owner.userId]);
  });
});

/** One change of a data route, in its own transaction, as a route makes it. */
async function change(tenantId: string, actorUserId: string, change: DataSettingChange): Promise<number> {
  return withTenantScope(appPool(), tenantId, (client) =>
    new MailOutbox({ secret: SECRET }).queueOwnerNotice(client, tenantId, { actorUserId, change }));
}

type Row = { user_id: string; status: string; created_at: Date; next_attempt_at: Date };

async function rowsOf(tenantId: string): Promise<Row[]> {
  return (await superuserPool().query<Row>(
    `SELECT user_id, status, created_at, next_attempt_at FROM email_outbox
     WHERE tenant_id = $1 AND kind = 'tenant_setting_changed' ORDER BY user_id, created_at`, [tenantId])).rows;
}

const serverChange = (i: number): DataSettingChange => ({ setting: "mcp_server", serverId: `server-${i}`, created: true });

// A loop of changes (a WorkOS token needs no step-up) must not flood the
// outbox that every tenant's email shares: one notice per owner per window.
describe.skipIf(!adminDatabaseUrl())("owner notices are combined", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });
  afterEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("100 changes queue at most one notice per owner; it lists the first changes and says there are more", async () => {
    const t = await workosTenant();
    for (let i = 0; i < 100; i += 1) {
      expect(await change(t.tenantId, t.owner.userId, serverChange(i))).toBe(2);
    }

    const rows = await rowsOf(t.tenantId);
    expect(rows.map((row) => [row.user_id, row.status])).toEqual(
      t.people.filter((person) => person.role === "owner" && person.email).map((owner) => [owner.userId, "queued"]).sort());
    for (const notice of await noticesOf(t.tenantId)) {
      expect(notice.mail.subject).toBe(SETTING_CHANGE_SUBJECT);
      expect(notice.mail.text).toContain("MCP server ID: server-0");
      expect(notice.mail.text).toContain(`MCP server ID: server-${OWNER_NOTICE_MAX_CHANGES - 1}`);
      expect(notice.mail.text).not.toContain(`MCP server ID: server-${OWNER_NOTICE_MAX_CHANGES}`);
      expect(notice.mail.text).toContain("And other changes. Examine the audit log.");
    }
  });

  test("after the notice of the window went out, later changes wait in one follow-up until the window ends", async () => {
    const t = await workosTenant();
    await change(t.tenantId, t.owner.userId, serverChange(0));
    // The worker sent the first notice.
    await superuserPool().query(
      `UPDATE email_outbox SET status = 'sent', message_encrypted = NULL, sent_at = now() WHERE tenant_id = $1`, [t.tenantId]);
    const first = (await rowsOf(t.tenantId))[0]!;

    for (const i of [1, 2, 3]) await change(t.tenantId, t.admin.userId, serverChange(i));

    const followUps = (await rowsOf(t.tenantId)).filter((row) => row.status === "queued");
    expect(followUps).toHaveLength(2);
    for (const row of followUps) {
      expect(Math.abs(row.next_attempt_at.getTime() - (first.created_at.getTime() + 15 * 60_000))).toBeLessThan(5_000);
    }
    const texts = (await noticesOf(t.tenantId)).map((notice) => notice.mail.text);
    for (const text of texts) {
      expect(text).not.toContain("MCP server ID: server-0");
      for (const i of [1, 2, 3]) expect(text).toContain(`MCP server ID: server-${i}`);
      expect(text).not.toContain("And other changes");
    }
  });

  test("after the window, a change goes out at once in a new notice", async () => {
    const t = await workosTenant();
    await change(t.tenantId, t.owner.userId, serverChange(0));
    // The window starts at the send: the notice went out 16 minutes ago.
    await superuserPool().query(
      `UPDATE email_outbox SET status = 'sent', message_encrypted = NULL, sent_at = now() - interval '16 minutes',
         created_at = now() - interval '16 minutes', next_attempt_at = now() - interval '16 minutes' WHERE tenant_id = $1`, [t.tenantId]);

    await change(t.tenantId, t.owner.userId, serverChange(1));

    const queued = (await rowsOf(t.tenantId)).filter((row) => row.status === "queued");
    expect(queued).toHaveLength(2);
    for (const row of queued) expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test("two changes at the same time still give one notice per owner", async () => {
    const t = await workosTenant();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstChange = withTenantScope(appPool(), t.tenantId, async (client) => {
      await new MailOutbox({ secret: SECRET }).queueOwnerNotice(client, t.tenantId, { actorUserId: t.owner.userId, change: serverChange(0) });
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondChange = change(t.tenantId, t.admin.userId, serverChange(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([firstChange, secondChange]);

    expect((await rowsOf(t.tenantId)).filter((row) => row.status === "queued")).toHaveLength(2);
    for (const notice of await noticesOf(t.tenantId)) {
      expect(notice.mail.text).toContain("MCP server ID: server-0");
      expect(notice.mail.text).toContain("MCP server ID: server-1");
    }
  });

  test("a tenant whose owners have no address: the notice reaches nobody", async () => {
    const t = await workosTenant();
    await superuserPool().query(`UPDATE users SET email = NULL WHERE user_id = ANY($1::text[])`,
      [t.people.filter((person) => person.role === "owner").map((person) => person.userId)]);
    expect(await change(t.tenantId, t.admin.userId, WEB_SEARCH)).toBe(0);
    expect(await rowsOf(t.tenantId)).toEqual([]);
  });
});

// The window of a notice starts when it is sent, and only a notice that
// waits for its first send attempt takes more changes.
describe.skipIf(!adminDatabaseUrl())("owner notice windows", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });
  afterEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a change just after the follow-up was sent waits a full window after that send", async () => {
    const t = await workosTenant();
    await change(t.tenantId, t.owner.userId, serverChange(0));
    // The first notice went out 20 minutes ago; its follow-up was due 5
    // minutes ago and went out one minute ago.
    await superuserPool().query(
      `UPDATE email_outbox SET status = 'sent', message_encrypted = NULL, created_at = now() - interval '20 minutes',
         next_attempt_at = now() - interval '20 minutes', sent_at = now() - interval '20 minutes' WHERE tenant_id = $1`, [t.tenantId]);
    await change(t.tenantId, t.owner.userId, serverChange(1));
    await superuserPool().query(
      `UPDATE email_outbox SET status = 'sent', message_encrypted = NULL, created_at = now() - interval '19 minutes',
         next_attempt_at = now() - interval '5 minutes', sent_at = now() - interval '1 minute'
       WHERE tenant_id = $1 AND status = 'queued'`, [t.tenantId]);

    await change(t.tenantId, t.owner.userId, serverChange(2));

    const queued = (await rowsOf(t.tenantId)).filter((row) => row.status === "queued");
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      // About 14 minutes from now: one window after the follow-up's send.
      expect(row.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(13 * 60_000);
    }
  });

  test.each([
    ["whose send failed and waits for a retry", "attempts = 1, next_attempt_at = now() + interval '2 minutes'"],
    ["that expired", "expires_at = now() - interval '1 minute'"]
  ])("a notice %s takes no more changes; they go into a new notice", async (_case, update) => {
    const t = await workosTenant();
    await change(t.tenantId, t.owner.userId, serverChange(0));
    await superuserPool().query(`UPDATE email_outbox SET ${update} WHERE tenant_id = $1`, [t.tenantId]);

    await change(t.tenantId, t.owner.userId, serverChange(1));

    const rows = await superuserPool().query<{ user_id: string; message_encrypted: string }>(
      `SELECT user_id, message_encrypted FROM email_outbox WHERE tenant_id = $1 ORDER BY user_id, created_at`, [t.tenantId]);
    expect(rows.rows).toHaveLength(4);
    const texts = rows.rows.map((row) => (JSON.parse(decrypt(row.message_encrypted, SECRET)) as OutgoingMail).text);
    // The older notice of each owner is unchanged; the new one has the change.
    expect(texts.filter((text) => text.includes("MCP server ID: server-1"))).toHaveLength(2);
    expect(texts.filter((text) => text.includes("MCP server ID: server-0") && text.includes("MCP server ID: server-1"))).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("organization rename", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a rename writes the audit event and emails the owners, with both names in labelled fields", async () => {
    const t = await workosTenant();
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = {
        userId: t.owner.userId, tenantId: t.tenantId, role: "owner", isAdmin: true, email: t.owner.email!,
        session: { authSource: "workos", familyId: "family-1" }
      };
    });
    await registerTenantRoutes(app, {
      db: appPool(), tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET),
      afterSecurityChange: IGNORE_SECURITY_CHANGE, dataRoutes: control()
    });
    await app.ready();
    try {
      expect((await app.inject({ method: "PUT", url: "/tenant", payload: { tenantName: "Acme Payroll" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: "/tenant", payload: { tenantName: "Acme https://evil.example" } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }

    const notices = await noticesOf(t.tenantId);
    expect(notices).toHaveLength(2);
    for (const line of ["Organization: Acme Payroll", `Organization ID: ${t.tenantId}`, "Setting: Organization name",
      "Previous name: Acme Data", "Change: The organization was renamed."]) {
      expect(notices[0]!.mail.text.split("\n"), line).toContain(line);
    }
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.renamed'`, [t.tenantId]);
    expect(audit.rows).toEqual([{ payload: { previousName: "Acme Data", tenantName: "Acme Payroll" } }]);
    expect((await superuserPool().query(`SELECT tenant_name FROM tenants WHERE tenant_id = $1`, [t.tenantId])).rows[0].tenant_name)
      .toBe("Acme Payroll");
  });
});

// An integration save that needs no step-up must not write back an older
// copy: an owner's change can come between the route's read and its write.
describe.skipIf(!adminDatabaseUrl())("integration save race", () => {
  const INTEGRATION = "race-app";
  if (!getIntegrationDescriptor(INTEGRATION)) {
    registerIntegration({
      id: INTEGRATION, name: "Race app", description: "", longDescription: "", logoSlug: "race", status: "available",
      category: "Test", readToolIds: ["race_read"], writeToolIds: [], configMode: "oauth_app",
      configFields: [
        { key: "siteUrl", label: "Site address", type: "url", required: true },
        { key: "clientSecret", label: "Client secret", type: "password", required: true }
      ]
    });
  }

  /** The store, with a change of another session just after the route's read. */
  class StoreWithChangeAfterRead extends IntegrationStateStore {
    afterRead: (() => Promise<void>) | null = null;
    override async get(tenantId: string, integrationId: string): Promise<IntegrationStateRecord | null> {
      const row = await super.get(tenantId, integrationId);
      const next = this.afterRead;
      this.afterRead = null;
      if (next) await next();
      return row;
    }
  }

  test.each([
    ["an empty save", {}],
    ["the old values again", { readsEnabled: true, config: { siteUrl: "https://old.example.com", clientSecret: "" } }]
  ])("%s does not undo an owner's change made after its read", async (_case, payload) => {
    await superuserPool().query(`DELETE FROM email_outbox`);
    const t = await workosTenant();
    const store = new StoreWithChangeAfterRead(appPool());
    await store.applyChanges(t.tenantId, INTEGRATION, {
      readsEnabled: true, configChanges: { siteUrl: "https://old.example.com", clientSecret: encrypt("old-secret", SECRET) }, updatedBy: t.owner.userId
    });
    // The owner turns access off and replaces the secret and the address.
    store.afterRead = async () => {
      await new IntegrationStateStore(appPool()).applyChanges(t.tenantId, INTEGRATION, {
        readsEnabled: false, configChanges: { siteUrl: "https://new.example.com", clientSecret: encrypt("new-secret", SECRET) }, updatedBy: t.owner.userId
      });
    };

    const app = Fastify();
    app.decorate("db", appPool());
    app.decorate("config", createTestConfig({ DATA_ENCRYPTION_SECRET: SECRET }));
    app.addHook("preHandler", async (request) => {
      request.auth = {
        userId: t.admin.userId, tenantId: t.tenantId, role: "admin", isAdmin: true, email: t.admin.email!,
        session: { authSource: "workos", familyId: "family-1" }
      };
    });
    await registerAdminIntegrationsRoutes(app, {
      config: createTestConfig({ DATA_ENCRYPTION_SECRET: SECRET }),
      integrationRegistry: {
        getIntegrationsForAdmin: async () => [],
        isReadyToEnable: async () => true
      } as never,
      integrationStates: store,
      auditEvents: new AuditEventStore(appPool()),
      runtimeAdapter: { invalidateTenantRuntimes: async () => [] },
      dataRoutes: control()
    });
    await app.ready();
    try {
      // The save changes nothing against the copy that it read: no step-up and no notice.
      await app.inject({ method: "PUT", url: `/admin/integrations/${INTEGRATION}`, payload });
    } finally {
      await app.close();
    }

    const row = await new IntegrationStateStore(appPool()).get(t.tenantId, INTEGRATION);
    expect(row?.readsEnabled).toBe(false);
    expect(row?.config.siteUrl).toBe("https://new.example.com");
    expect(decrypt(String(row?.config.clientSecret), SECRET)).toBe("new-secret");
    expect(await noticesOf(t.tenantId)).toEqual([]);
  });

  // applyChanges merges onto the row as it is when it holds the row lock: a
  // change that another transaction commits meanwhile stays.
  test("a write waits for the row and keeps a settings key that another transaction changed meanwhile", async () => {
    const t = await workosTenant();
    const store = new IntegrationStateStore(appPool());
    await store.applyChanges(t.tenantId, INTEGRATION, { configChanges: { siteUrl: "https://old.example.com" }, updatedBy: t.owner.userId });

    const other = await superuserPool().connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND integration_id = $2 FOR UPDATE`, [t.tenantId, INTEGRATION]);
      const write = store.applyChanges(t.tenantId, INTEGRATION, {
        configChanges: { clientSecret: encrypt("secret", SECRET) }, updatedBy: t.admin.userId
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query(
        `UPDATE tenant_integrations SET config_json = config_json || '{"siteUrl": "https://new.example.com"}'::jsonb
         WHERE tenant_id = $1 AND integration_id = $2`, [t.tenantId, INTEGRATION]);
      await other.query("COMMIT");
      await write;
    } finally {
      other.release();
    }

    const row = await store.get(t.tenantId, INTEGRATION);
    expect(row?.config.siteUrl).toBe("https://new.example.com");
    expect(decrypt(String(row?.config.clientSecret), SECRET)).toBe("secret");
  });
});

describe.skipIf(!adminDatabaseUrl())("migration 082", () => {
  test("drops the rows of accounts that are no longer members, keeps the others, and allows the new kind", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) < 82);

      const tenant = "tenant-082";
      await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug, login_type) VALUES ($1, 'Acme', $1, 'local')`, [tenant]);
      for (const user of ["kept-082", "removed-082"]) {
        await db.query(`INSERT INTO users (user_id, email, auth_source) VALUES ($1, $2, 'local')`, [user, `${user}@example.test`]);
        await db.query(`INSERT INTO local_identities (tenant_id, user_id, status) VALUES ($1, $2, 'active')`, [tenant, user]);
        await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, user_auth_source) VALUES ($1, $2, 'member', 'local')`, [tenant, user]);
        await db.query(
          `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, status, expires_at)
           VALUES ($1, $2, $3, 'password_changed', 'sent', now() + interval '1 day')`,
          [tenant, `email-${user}`, user]
        );
      }
      // Removal before 082: the identity stays (marked removed), the membership goes.
      await db.query(`UPDATE local_identities SET status = 'removed' WHERE user_id = 'removed-082'`);
      await db.query(`DELETE FROM tenant_memberships WHERE user_id = 'removed-082'`);
      await expect(db.query(
        `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, status, expires_at)
         VALUES ($1, 'email-new-kind', 'kept-082', 'tenant_setting_changed', 'sent', now() + interval '1 day')`, [tenant]
      )).rejects.toMatchObject({ constraint: "email_outbox_kind_check" });

      await migrate((file) => file.startsWith("082_"));

      expect((await db.query(`SELECT email_id FROM email_outbox ORDER BY email_id`)).rows).toEqual([{ email_id: "email-kept-082" }]);
      await db.query(
        `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, status, expires_at)
         VALUES ($1, 'email-new-kind', 'kept-082', 'tenant_setting_changed', 'sent', now() + interval '1 day')`, [tenant]
      );
      const keys = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'email_outbox'::regclass AND contype = 'f' ORDER BY conname`);
      expect(keys.rows.map((row) => row.conname)).toEqual(["email_outbox_membership_fkey", "email_outbox_tenant_id_fkey"]);
    });
  });
});
