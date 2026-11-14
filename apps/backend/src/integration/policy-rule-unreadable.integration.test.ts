import { describe, expect, test } from "vitest";

import { evaluatePolicy } from "../services/policy/policy-engine.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";
import { ALLOW_WEAKER } from "../test-helpers/data-routes.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

// Issue #121, against Postgres: a stored rule whose conditions the strict
// schema cannot read blocks every action, and the store's SQL keeps the stored
// JSON until a patch sends new conditions (COALESCE in PolicyRuleStore.update).

const action = { toolName: "search", category: "github", severity: "read_only" as const, serverId: "github", turnContext: "interactive" as const };

async function storedConditions(tenantId: string, ruleId: string): Promise<unknown> {
  const { rows } = await superuserPool().query<{ conditions_json: unknown }>(
    "SELECT conditions_json FROM policy_rule WHERE tenant_id = $1 AND rule_id = $2", [tenantId, ruleId]);
  return rows[0]?.conditions_json;
}

describe.skipIf(!adminDatabaseUrl())("a stored policy rule whose conditions cannot be read", () => {
  test("reads as unreadable, blocks every action, and keeps its stored JSON on a rename", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const typo = await store.create(owner.tenantId, { name: "allow one tool", effect: "allow", priority: 0,
      conditions: { toolNames: ["search"] } }, owner.userId, ALLOW_WEAKER);
    await store.create(owner.tenantId, { name: "block exports", effect: "block", priority: 10,
      conditions: { toolNames: ["export"] } }, owner.userId, ALLOW_WEAKER);
    // An old or hand-edited row: the input schema refuses this key at create.
    await superuserPool().query(
      "UPDATE policy_rule SET conditions_json = $3::jsonb WHERE tenant_id = $1 AND rule_id = $2",
      [owner.tenantId, typo.ruleId, JSON.stringify({ toolName: ["search"] })]);

    const rules = await store.list(owner.tenantId);
    expect(rules[0]).toMatchObject({ ruleId: typo.ruleId, conditions: {}, conditionsInvalid: true });
    for (const toolName of ["search", "export", "anything"]) {
      expect(evaluatePolicy(rules, { ...action, toolName })).toMatchObject({ outcome: "block", matchedRuleId: typo.ruleId });
    }

    const renamed = await store.update(owner.tenantId, typo.ruleId,
      { expectedRevision: typo.revision, name: "renamed" }, { allowWeaker: false });
    expect(renamed).toMatchObject({ name: "renamed", conditionsInvalid: true });
    expect(await storedConditions(owner.tenantId, typo.ruleId)).toEqual({ toolName: ["search"] });

    // Disabling it lets "search" through again: weaker, so step-up is needed.
    await expect(store.update(owner.tenantId, typo.ruleId,
      { expectedRevision: renamed!.revision, enabled: false }, { allowWeaker: false }))
      .rejects.toBeInstanceOf(WeakerChangeError);

    // With step-up, the repair writes the new conditions.
    const repaired = await store.update(owner.tenantId, typo.ruleId,
      { expectedRevision: renamed!.revision, conditions: { toolNames: ["search"] } }, ALLOW_WEAKER);
    expect(repaired).not.toHaveProperty("conditionsInvalid");
    expect(await storedConditions(owner.tenantId, typo.ruleId)).toEqual({ toolNames: ["search"] });
  });
});
