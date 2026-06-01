import { test, expect } from "vitest";

import Fastify from "fastify";

import type {
  PolicyDecision,
  PolicyDecisionFilters,
  PolicyRule,
  PolicyRuleInput,
  PolicyRulePatch
} from "@cogniplane/shared-types";

import { registerAdminPolicyRoutes } from "./admin-policy-routes.js";
import type { Pool } from "../../lib/db.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import { PolicyService } from "../../services/policy/policy-service.js";
import type { PolicyDecisionStore } from "../../services/policy/policy-decision-store.js";
import {
  PolicyReorderMismatchError,
  type PolicyRuleStore
} from "../../services/policy/policy-rule-store.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

// In-memory rule store keyed by tenant. Mirrors the real store's contract
// (list ordered by priority, partial update, unique ruleId per tenant).
class InMemoryRuleStore {
  private rules: PolicyRule[] = [];
  private seq = 0;

  async list(tenantId: string): Promise<PolicyRule[]> {
    return this.rules
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.ruleId.localeCompare(b.ruleId)));
  }

  async get(tenantId: string, ruleId: string): Promise<PolicyRule | null> {
    return this.rules.find((r) => r.tenantId === tenantId && r.ruleId === ruleId) ?? null;
  }

  async nextAppendPriority(tenantId: string): Promise<number> {
    const priorities = this.rules.filter((r) => r.tenantId === tenantId).map((r) => r.priority);
    return priorities.length === 0 ? 0 : Math.max(...priorities) + 10;
  }

  async create(tenantId: string, input: PolicyRuleInput, createdBy: string | null): Promise<PolicyRule> {
    const rule: PolicyRule = {
      ruleId: `pol_${++this.seq}`,
      tenantId,
      name: input.name,
      description: input.description ?? null,
      // Mirror the real store: no explicit priority → append to the end.
      priority: input.priority ?? (await this.nextAppendPriority(tenantId)),
      enabled: input.enabled ?? true,
      effect: input.effect,
      conditions: input.conditions ?? {},
      reason: input.reason ?? null,
      createdBy,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z"
    };
    this.rules.push(rule);
    return rule;
  }

  async update(tenantId: string, ruleId: string, input: PolicyRulePatch): Promise<PolicyRule | null> {
    const existing = await this.get(tenantId, ruleId);
    if (!existing) return null;
    const updated: PolicyRule = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
      effect: input.effect ?? existing.effect,
      conditions: input.conditions ?? existing.conditions,
      reason: input.reason !== undefined ? input.reason : existing.reason,
      updatedAt: "2026-05-31T00:01:00.000Z"
    };
    this.rules = this.rules.map((r) => (r.ruleId === ruleId && r.tenantId === tenantId ? updated : r));
    return updated;
  }

  async delete(tenantId: string, ruleId: string): Promise<boolean> {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => !(r.tenantId === tenantId && r.ruleId === ruleId));
    return this.rules.length < before;
  }

  // Mirrors the real store: carries the raw stored conditions (the .passthrough()
  // input schema preserves unknown keys, so they survive here) for the lint.
  async listForLint(tenantId: string) {
    return (await this.list(tenantId)).map((rule) => ({
      ruleId: rule.ruleId,
      name: rule.name,
      priority: rule.priority,
      enabled: rule.enabled,
      conditions: rule.conditions
    }));
  }

  async reorder(tenantId: string, ruleIds: readonly string[]): Promise<PolicyRule[]> {
    if (new Set(ruleIds).size !== ruleIds.length) {
      throw new PolicyReorderMismatchError("ruleIds must not contain duplicates.");
    }
    const existing = this.rules.filter((r) => r.tenantId === tenantId);
    const existingIds = new Set(existing.map((r) => r.ruleId));
    if (existingIds.size !== ruleIds.length || ruleIds.some((id) => !existingIds.has(id))) {
      throw new PolicyReorderMismatchError(
        "ruleIds must be exactly the tenant's current set of policy rules."
      );
    }
    ruleIds.forEach((id, index) => {
      this.rules = this.rules.map((r) =>
        r.tenantId === tenantId && r.ruleId === id ? { ...r, priority: index * 10 } : r
      );
    });
    return this.list(tenantId);
  }
}

// In-memory decision store that mirrors the real store's filtering/paging/total
// contract so the route's query parsing and envelope are exercised end-to-end.
type SeededDecision = PolicyDecision & { actionSnapshot?: Record<string, unknown> };

class InMemoryDecisionStore {
  private decisions: SeededDecision[] = [];

  seed(decisions: SeededDecision[]): void {
    this.decisions = decisions;
  }

  async record() {
    throw new Error("decisions are not recorded via the admin routes");
  }

  async list(tenantId: string, filters: PolicyDecisionFilters = {}) {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let rows = this.decisions
      .filter((d) => d.tenantId === tenantId)
      .filter((d) => (filters.sessionId ? d.sessionId === filters.sessionId : true))
      .filter((d) => (filters.outcomes?.length ? filters.outcomes.includes(d.outcome) : true))
      .filter((d) => (filters.enforced === undefined ? true : d.enforced === filters.enforced))
      .filter((d) => (filters.toolNames?.length ? filters.toolNames.includes(d.toolName) : true))
      .filter((d) => (filters.severities?.length ? d.severity != null && filters.severities.includes(d.severity) : true))
      .filter((d) => (filters.from ? Date.parse(d.createdAt) >= Date.parse(filters.from) : true))
      .filter((d) => (filters.to ? Date.parse(d.createdAt) < Date.parse(filters.to) + ONE_DAY : true))
      .filter((d) => (filters.before ? Date.parse(d.createdAt) <= Date.parse(filters.before) : true));
    rows = rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const total = rows.length;
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 500);
    const offset = Math.min(Math.max(filters.offset ?? 0, 0), 100_000);
    const page = rows.slice(offset, offset + limit).map(({ actionSnapshot: _omit, ...row }) => row);
    return { decisions: page, total, hasMore: offset + page.length < total, limit, offset };
  }

  async get(tenantId: string, decisionId: string) {
    const found = this.decisions.find((d) => d.tenantId === tenantId && d.decisionId === decisionId);
    if (!found) return null;
    const { actionSnapshot = {}, ...row } = found;
    return { ...row, actionSnapshot };
  }
}

function fakeDecision(overrides: Partial<SeededDecision> & Pick<SeededDecision, "decisionId">): SeededDecision {
  return {
    tenantId: "t1",
    sessionId: null,
    userId: null,
    runtimeId: null,
    toolName: "github_create_pr",
    toolCategory: null,
    severity: null,
    serverId: null,
    matchedRuleId: null,
    outcome: "allow",
    enforced: false,
    explanation: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
}

async function buildApp() {
  const app = Fastify();
  const ruleStore = new InMemoryRuleStore();
  const decisionStore = new InMemoryDecisionStore();
  const audit = new InMemoryAuditEventStore();
  const policyService = new PolicyService({
    rules: ruleStore as unknown as PolicyRuleStore,
    decisions: decisionStore as unknown as PolicyDecisionStore,
    auditEvents: audit as unknown as AuditEventStore
  });

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "t1",
      isAdmin: true,
      role: "owner" as const
    };
  });

  await registerAdminPolicyRoutes(app, {
    policyRules: ruleStore as unknown as PolicyRuleStore,
    policyDecisions: decisionStore as unknown as PolicyDecisionStore,
    policyService,
    auditEvents: audit as unknown as AuditEventStore
  });
  await app.ready();
  return { app, audit, decisionStore };
}

test("create → list round-trips a rule and audits the creation", async () => {
  const { app, audit } = await buildApp();

  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: {
      name: "Block GitHub writes",
      effect: "block",
      conditions: { categories: ["github"], severities: ["file_change"] },
      reason: "External writes require review."
    }
  });
  expect(created.statusCode).toBe(200);
  const rule = created.json().rule;
  expect(rule.ruleId).toMatch(/^pol_/);
  expect(rule.effect).toBe("block");
  expect(audit.events.at(-1)?.type).toBe("admin.policy_rule.created");

  const list = await app.inject({ method: "GET", url: "/admin/policy/rules" });
  expect(list.statusCode).toBe(200);
  expect(list.json().rules).toHaveLength(1);
  expect(list.json().rules[0].name).toBe("Block GitHub writes");

  await app.close();
});

test("create a require_approval rule round-trips its effect", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "Approve shell", effect: "require_approval", conditions: { severities: ["command_execution"] } }
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().rule.effect).toBe("require_approval");
  await app.close();
});

test("create an allow rule round-trips its effect", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "Allow reads", effect: "allow", conditions: { categories: ["github"] } }
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().rule.effect).toBe("allow");
  await app.close();
});

test("invalid effect is rejected with 400", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "Bad", effect: "obliterate" }
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("create rejects removed top-level rule fields", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: {
      name: "Stale client",
      effect: "block",
      mode: "enforce",
      transform: [{ kind: "redact", path: "secret" }]
    }
  });
  expect(res.statusCode).toBe(400);
  expect(JSON.stringify(res.json().details)).toContain("Unrecognized");
  await app.close();
});

test("create round-trips the kept condition dimensions (categories/severities/turnContexts)", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: {
      name: "Strict scheduled github writes",
      effect: "block",
      conditions: {
        categories: ["github"],
        turnContexts: ["scheduled"],
        severities: ["file_change"]
      }
    }
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().rule.conditions).toEqual({
    categories: ["github"],
    turnContexts: ["scheduled"],
    severities: ["file_change"]
  });
  await app.close();
});

test("rejects an unknown turnContext value with 400", async () => {
  const { app } = await buildApp();
  const badTurn = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "Bad turn", effect: "block", conditions: { turnContexts: ["cron"] } }
  });
  expect(badTurn.statusCode).toBe(400);
  await app.close();
});

test("simulate matches a turnContext rule", async () => {
  const { app } = await buildApp();
  await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: {
      name: "Block scheduled github writes",
      effect: "block",
      conditions: { categories: ["github"], turnContexts: ["scheduled"] }
    }
  });
  const sim = await app.inject({
    method: "POST",
    url: "/admin/policy/simulate",
    payload: {
      toolName: "github_write_file",
      category: "github",
      turnContext: "scheduled"
    }
  });
  expect(sim.statusCode).toBe(200);
  expect(sim.json().outcome).toBe("block");
  expect(sim.json().enforced).toBe(true);

  // A different turnContext → no match.
  const simInteractive = await app.inject({
    method: "POST",
    url: "/admin/policy/simulate",
    payload: { toolName: "github_write_file", category: "github", turnContext: "interactive" }
  });
  expect(simInteractive.json().outcome).toBe("allow");
  await app.close();
});

test("patch updates a rule and audits it", async () => {
  const { app, audit } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "R", effect: "block" }
  });
  const ruleId = created.json().rule.ruleId;

  const patched = await app.inject({
    method: "PATCH",
    url: `/admin/policy/rules/${ruleId}`,
    payload: { name: "R", effect: "require_approval" }
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().rule.effect).toBe("require_approval");
  expect(audit.events.at(-1)?.type).toBe("admin.policy_rule.updated");
  await app.close();
});

test("patch accepts a partial body (only enabled) and preserves the existing effect", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "R", effect: "block", enabled: true }
  });
  const ruleId = created.json().rule.ruleId;

  // PATCH with ONLY enabled — no name, no effect. Must succeed (200), not 400.
  const patched = await app.inject({
    method: "PATCH",
    url: `/admin/policy/rules/${ruleId}`,
    payload: { enabled: false }
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().rule.enabled).toBe(false);
  // Untouched fields are preserved.
  expect(patched.json().rule.effect).toBe("block");
  expect(patched.json().rule.name).toBe("R");
  await app.close();
});

test("patch with an empty body is rejected", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "R", effect: "block" }
  });
  const ruleId = created.json().rule.ruleId;

  const res = await app.inject({
    method: "PATCH",
    url: `/admin/policy/rules/${ruleId}`,
    payload: {}
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("patch with only an unknown/typo'd field is rejected (no silent no-op + false audit)", async () => {
  const { app, audit } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "R", effect: "block", enabled: true }
  });
  const ruleId = created.json().rule.ruleId;
  const auditCountBefore = audit.events.length;

  // `enbaled` is a typo — strict schema must reject it rather than passing the
  // non-empty check and producing a no-op UPDATE + a false "updated" audit.
  const res = await app.inject({
    method: "PATCH",
    url: `/admin/policy/rules/${ruleId}`,
    payload: { enbaled: false }
  });
  expect(res.statusCode).toBe(400);
  // No "admin.policy_rule.updated" audit event should have fired.
  expect(audit.events.length).toBe(auditCountBefore);
  await app.close();
});

test("patch on an unknown rule returns 404", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/admin/policy/rules/pol_missing",
    payload: { name: "x", effect: "block" }
  });
  expect(res.statusCode).toBe(404);
  await app.close();
});

test("delete removes a rule and 404s the second time", async () => {
  const { app, audit } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "R", effect: "block" }
  });
  const ruleId = created.json().rule.ruleId;

  const first = await app.inject({ method: "DELETE", url: `/admin/policy/rules/${ruleId}` });
  expect(first.statusCode).toBe(204);
  expect(audit.events.at(-1)?.type).toBe("admin.policy_rule.deleted");

  const second = await app.inject({ method: "DELETE", url: `/admin/policy/rules/${ruleId}` });
  expect(second.statusCode).toBe(404);
  await app.close();
});

test("simulate evaluates an action against active rules without recording", async () => {
  const { app } = await buildApp();
  await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: {
      name: "Block GH writes",
      effect: "block",
      conditions: { categories: ["github"] }
    }
  });

  const matched = await app.inject({
    method: "POST",
    url: "/admin/policy/simulate",
    payload: { toolName: "github_write_file", category: "github", severity: "file_change" }
  });
  expect(matched.statusCode).toBe(200);
  expect(matched.json().outcome).toBe("block");
  expect(matched.json().enforced).toBe(true);
  expect(matched.json().matchedRuleName).toBe("Block GH writes");

  const unmatched = await app.inject({
    method: "POST",
    url: "/admin/policy/simulate",
    payload: { toolName: "notion_create_page", category: "notion" }
  });
  expect(unmatched.json().outcome).toBe("allow");
  expect(unmatched.json().matchedRuleId).toBeNull();

  await app.close();
});

test("decisions endpoint returns an empty paginated envelope when there are none", async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/admin/policy/decisions" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ decisions: [], total: 0, hasMore: false, offset: 0 });
  await app.close();
});

test("decisions endpoint filters by outcome, enforced, tool, and severity", async () => {
  const { app, decisionStore } = await buildApp();
  decisionStore.seed([
    fakeDecision({ decisionId: "d1", outcome: "block", enforced: true, toolName: "github_create_pr", severity: "command_execution" }),
    fakeDecision({ decisionId: "d2", outcome: "allow", enforced: false, toolName: "notion_create_page", severity: "read_only" }),
    fakeDecision({ decisionId: "d3", outcome: "block", enforced: false, toolName: "github_create_pr", severity: "file_change" })
  ]);

  const byOutcome = await app.inject({ method: "GET", url: "/admin/policy/decisions?outcomes=block" });
  expect(byOutcome.json().total).toBe(2);
  expect(byOutcome.json().decisions.map((d: PolicyDecision) => d.decisionId).sort()).toEqual(["d1", "d3"]);

  const enforcedOnly = await app.inject({ method: "GET", url: "/admin/policy/decisions?enforced=true" });
  expect(enforcedOnly.json().decisions.map((d: PolicyDecision) => d.decisionId)).toEqual(["d1"]);

  const monitorOnly = await app.inject({ method: "GET", url: "/admin/policy/decisions?enforced=false" });
  expect(monitorOnly.json().total).toBe(2);

  const byTool = await app.inject({ method: "GET", url: "/admin/policy/decisions?toolNames=notion_create_page" });
  expect(byTool.json().decisions.map((d: PolicyDecision) => d.decisionId)).toEqual(["d2"]);

  const bySeverity = await app.inject({ method: "GET", url: "/admin/policy/decisions?severities=command_execution,file_change" });
  expect(bySeverity.json().total).toBe(2);

  await app.close();
});

test("decisions endpoint paginates with offset and reports total + hasMore", async () => {
  const { app, decisionStore } = await buildApp();
  decisionStore.seed(
    Array.from({ length: 7 }, (_, i) =>
      fakeDecision({
        decisionId: `d${i}`,
        // Strictly descending timestamps so newest-first order is deterministic.
        createdAt: new Date(Date.parse("2026-05-31T00:00:00.000Z") - i * 60_000).toISOString()
      })
    )
  );

  const page1 = await app.inject({ method: "GET", url: "/admin/policy/decisions?limit=3&offset=0" });
  expect(page1.json()).toMatchObject({ total: 7, limit: 3, offset: 0, hasMore: true });
  expect(page1.json().decisions.map((d: PolicyDecision) => d.decisionId)).toEqual(["d0", "d1", "d2"]);

  const page3 = await app.inject({ method: "GET", url: "/admin/policy/decisions?limit=3&offset=6" });
  expect(page3.json()).toMatchObject({ total: 7, offset: 6, hasMore: false });
  expect(page3.json().decisions.map((d: PolicyDecision) => d.decisionId)).toEqual(["d6"]);

  await app.close();
});

test("decisions endpoint date range is inclusive of the picked end day", async () => {
  const { app, decisionStore } = await buildApp();
  decisionStore.seed([
    fakeDecision({ decisionId: "before", createdAt: "2026-05-09T23:59:00.000Z" }),
    fakeDecision({ decisionId: "endday", createdAt: "2026-05-10T18:00:00.000Z" }),
    fakeDecision({ decisionId: "after", createdAt: "2026-05-11T00:30:00.000Z" })
  ]);

  // to=2026-05-10 must still include the same-day 18:00 row (half-open: < 05-11).
  const res = await app.inject({ method: "GET", url: "/admin/policy/decisions?from=2026-05-10&to=2026-05-10" });
  expect(res.json().decisions.map((d: PolicyDecision) => d.decisionId)).toEqual(["endday"]);

  await app.close();
});

test("decisions endpoint accepts repeated multi-value params (?k=a&k=b)", async () => {
  const { app, decisionStore } = await buildApp();
  decisionStore.seed([
    fakeDecision({ decisionId: "d1", outcome: "block" }),
    fakeDecision({ decisionId: "d2", outcome: "allow" }),
    fakeDecision({ decisionId: "d3", outcome: "require_approval" })
  ]);

  // Repeated params must not 500 (Fastify parses them as string[]); they OR together.
  const res = await app.inject({
    method: "GET",
    url: "/admin/policy/decisions?outcomes=block&outcomes=allow"
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().total).toBe(2);
  expect(res.json().decisions.map((d: PolicyDecision) => d.decisionId).sort()).toEqual(["d1", "d2"]);

  // A mix of repeated + comma-separated also flattens correctly.
  const mixed = await app.inject({
    method: "GET",
    url: "/admin/policy/decisions?outcomes=block,allow&outcomes=require_approval"
  });
  expect(mixed.json().total).toBe(3);

  await app.close();
});

test("decisions endpoint rejects an invalid filter value with 400", async () => {
  const { app } = await buildApp();
  const badOutcome = await app.inject({ method: "GET", url: "/admin/policy/decisions?outcomes=not_a_real_effect" });
  expect(badOutcome.statusCode).toBe(400);
  const badEnforced = await app.inject({ method: "GET", url: "/admin/policy/decisions?enforced=maybe" });
  expect(badEnforced.statusCode).toBe(400);
  await app.close();
});

test("decision detail returns the row with its action snapshot", async () => {
  const { app, decisionStore } = await buildApp();
  decisionStore.seed([
    fakeDecision({
      decisionId: "d1",
      outcome: "block",
      actionSnapshot: { toolName: "github_create_pr", turnContext: "interactive" }
    })
  ]);
  const res = await app.inject({ method: "GET", url: "/admin/policy/decisions/d1" });
  expect(res.statusCode).toBe(200);
  expect(res.json().decision.decisionId).toBe("d1");
  expect(res.json().decision.outcome).toBe("block");
  expect(res.json().decision.actionSnapshot).toEqual({
    toolName: "github_create_pr",
    turnContext: "interactive"
  });
  await app.close();
});

test("decision detail 404s for an unknown decision id", async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/admin/policy/decisions/nope" });
  expect(res.statusCode).toBe(404);
  await app.close();
});

// ── Reorder ──────────────────────────────────────────────────────────────────

// Create N rules via the API and return their ids in creation order.
async function createRules(app: Awaited<ReturnType<typeof buildApp>>["app"], names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const res = await app.inject({ method: "POST", url: "/admin/policy/rules", payload: { name, effect: "allow" } });
    ids.push(res.json().rule.ruleId);
  }
  return ids;
}

test("new rules append to the end of the evaluation order (max priority + 10)", async () => {
  const { app } = await buildApp();
  await createRules(app, ["first", "second", "third"]);
  const rules = (await app.inject({ method: "GET", url: "/admin/policy/rules" })).json().rules;
  expect(rules.map((r: { name: string }) => r.name)).toEqual(["first", "second", "third"]);
  // 0, 10, 20 — strictly ascending so creation order is preserved.
  expect(rules.map((r: { priority: number }) => r.priority)).toEqual([0, 10, 20]);
  await app.close();
});

test("reorder rewrites priorities to match the requested order and audits it", async () => {
  const { app, audit } = await buildApp();
  const [a, b, c] = await createRules(app, ["a", "b", "c"]);

  const res = await app.inject({
    method: "PUT",
    url: "/admin/policy/rules/order",
    payload: { ruleIds: [c, a, b] }
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().rules.map((r: { ruleId: string }) => r.ruleId)).toEqual([c, a, b]);
  expect(res.json().rules.map((r: { priority: number }) => r.priority)).toEqual([0, 10, 20]);
  // The reorder must be audited.
  expect(audit.events.at(-1)?.type).toBe("admin.policy_rule.reordered");
  await app.close();
});

test("reorder with a drifted rule-id set is rejected 409 (and not applied)", async () => {
  const { app } = await buildApp();
  const [a, b, c] = await createRules(app, ["a", "b", "c"]);

  // Omit `c` — the set no longer matches, so the whole reorder must 409.
  const res = await app.inject({
    method: "PUT",
    url: "/admin/policy/rules/order",
    payload: { ruleIds: [b, a] }
  });
  expect(res.statusCode).toBe(409);

  // Order unchanged (still creation order).
  const rules = (await app.inject({ method: "GET", url: "/admin/policy/rules" })).json().rules;
  expect(rules.map((r: { ruleId: string }) => r.ruleId)).toEqual([a, b, c]);
  await app.close();
});

test("reorder rejects a body with duplicate ids with 400 (schema)", async () => {
  const { app } = await buildApp();
  const [a, b] = await createRules(app, ["a", "b"]);
  const res = await app.inject({
    method: "PUT",
    url: "/admin/policy/rules/order",
    payload: { ruleIds: [a, a, b] }
  });
  // Duplicate detection is a schema refinement → 400 before the store is hit.
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("reorder with an empty body is rejected", async () => {
  const { app } = await buildApp();
  await createRules(app, ["a"]);
  const res = await app.inject({
    method: "PUT",
    url: "/admin/policy/rules/order",
    payload: {}
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

// ── Lint ───────────────────────────────────────────────────────────────────

test("lint endpoint flags a shadowed rule (unreachable behind a broader rule)", async () => {
  const { app } = await buildApp();
  // The broad rule is created first (higher priority); the narrower rule created
  // after it is fully subsumed, so it can never match — the warning targets it.
  await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "github broad", effect: "block", conditions: { categories: ["github"] } }
  });
  await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "github narrow", effect: "block", conditions: { categories: ["github"], toolNames: ["github_write_file"] } }
  });
  const res = await app.inject({ method: "GET", url: "/admin/policy/lint" });
  expect(res.statusCode).toBe(200);
  const warnings = res.json().warnings;
  expect(warnings).toHaveLength(1);
  expect(warnings[0].kind).toBe("shadowed");
  expect(warnings[0].ruleName).toBe("github narrow");
  await app.close();
});

test("lint endpoint returns no warnings for a clean rule set", async () => {
  const { app } = await buildApp();
  await app.inject({ method: "POST", url: "/admin/policy/rules", payload: { name: "gh", effect: "allow", conditions: { categories: ["github"] } } });
  await app.inject({ method: "POST", url: "/admin/policy/rules", payload: { name: "notion", effect: "allow", conditions: { categories: ["notion"] } } });
  const res = await app.inject({ method: "GET", url: "/admin/policy/lint" });
  expect(res.json().warnings).toEqual([]);
  await app.close();
});

test("lint endpoint flags an unknown/typo'd condition key on a PERSISTED rule", async () => {
  const { app } = await buildApp();
  // `toolName` (singular) is not a known dimension. The API .passthrough()s it,
  // and the lint reads the raw stored conditions (listForLint) — so the warning
  // must fire even though toConditions() would drop the key for the engine.
  const created = await app.inject({
    method: "POST",
    url: "/admin/policy/rules",
    payload: { name: "typo rule", effect: "allow", conditions: { toolName: ["github_write_file"] } }
  });
  expect(created.statusCode).toBe(200);
  const res = await app.inject({ method: "GET", url: "/admin/policy/lint" });
  const warnings = res.json().warnings;
  expect(warnings).toHaveLength(1);
  expect(warnings[0].kind).toBe("unknown_condition");
  expect(warnings[0].message).toContain("toolName");
  await app.close();
});
