import { describe, expect, it, vi } from "vitest";

import type { PolicyEnforcementMode, PolicyRule } from "@cogniplane/shared-types";

import type { PolicyApprovalDisposition } from "../../runtime-contracts.js";
import {
  PolicyService,
  PolicyBlockedError,
  type PolicyGateInput
} from "./policy-service.js";
import type { PolicyRuleStore } from "./policy-rule-store.js";
import type { PolicyDecisionStore } from "./policy-decision-store.js";
import type { AuditEventStore } from "../audit-event-store.js";

type RuleSeed = Partial<PolicyRule> & { ruleId: string; effect: PolicyRule["effect"] };

function makeRule(seed: RuleSeed): PolicyRule {
  return {
    tenantId: "t1",
    description: null,
    priority: 100,
    enabled: true,
    conditions: {},
    reason: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: seed.name ?? seed.ruleId,
    ...seed
  };
}

function fakeRuleStore(rules: PolicyRule[]): PolicyRuleStore {
  return {
    list: vi.fn(async () => rules)
  } as unknown as PolicyRuleStore;
}

function fakeDecisionStore(opts: { fail?: boolean } = {}): {
  store: PolicyDecisionStore;
  records: Array<Record<string, unknown>>;
} {
  const records: Array<Record<string, unknown>> = [];
  return {
    store: {
      record: vi.fn(async (_tenantId: string, input: Record<string, unknown>) => {
        if (opts.fail) throw new Error("decision store down");
        records.push(input);
        return { decisionId: "pdc_1", ...input } as never;
      })
    } as unknown as PolicyDecisionStore,
    records
  };
}

function fakeAuditStore(): { store: AuditEventStore; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    store: {
      create: vi.fn(async (event: Record<string, unknown>) => {
        events.push(event);
        return undefined as never;
      })
    } as unknown as AuditEventStore,
    events
  };
}

function buildService(rules: PolicyRule[], decisionOpts: { fail?: boolean } = {}) {
  const ruleStore = fakeRuleStore(rules);
  const { store: decisions, records } = fakeDecisionStore(decisionOpts);
  const { store: auditEvents, events } = fakeAuditStore();
  const warnings: Array<{ msg: string; meta?: unknown }> = [];
  const service = new PolicyService({
    rules: ruleStore,
    decisions,
    auditEvents,
    logger: { warn: (msg, meta) => warnings.push({ msg, meta }) }
  });
  return { service, records, events, warnings };
}

function gateInput(overrides: Partial<PolicyGateInput> = {}): PolicyGateInput {
  return {
    tenantId: "t1",
    sessionId: "s1",
    userId: "u1",
    runtimeId: "r1",
    toolName: "github_write_file",
    category: "github",
    severity: "file_change",
    serverId: "github",
    turnContext: "interactive",
    enforcementMode: "enforce" as PolicyEnforcementMode,
    ...overrides
  };
}

describe("PolicyService.gateAction — non-gating outcomes", () => {
  it("no matching rule → proceeds, records nothing", async () => {
    const { service, records, events } = buildService([
      makeRule({ ruleId: "pol_1", effect: "block", conditions: { toolNames: ["other"] } })
    ]);
    const result = await service.gateAction(gateInput());
    expect(result.enforced).toBe(false);
    expect(result.evaluation.outcome).toBe("allow");
    expect(result.evaluation.matchedRuleId).toBeNull();
    // A default-allow no-match must NOT write an evidence row.
    expect(records).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("an `allow` rule proceeds but is recorded as evidence", async () => {
    const { service, records, events } = buildService([
      makeRule({ ruleId: "pol_1", effect: "allow", conditions: { categories: ["github"] } })
    ]);
    const result = await service.gateAction(gateInput());
    expect(result.enforced).toBe(false);
    expect(result.evaluation.outcome).toBe("allow");
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("allow");
    expect(records[0].enforced).toBe(false);
    expect(events[0].type).toBe("policy.decision.recorded");
  });

  it("monitor mode never gates a block — records a would-have decision", async () => {
    const { service, records } = buildService([
      makeRule({ ruleId: "pol_1", effect: "block", conditions: { categories: ["github"] } })
    ]);
    const result = await service.gateAction(gateInput({ enforcementMode: "monitor" }));
    // Even though the rule is `block`, monitor mode proceeds.
    expect(result.enforced).toBe(false);
    expect(result.evaluation.outcome).toBe("block");
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("block");
    expect(records[0].enforced).toBe(false);
  });
});

describe("PolicyService.gateAction — enforce-mode block", () => {
  it("throws PolicyBlockedError and records an enforced decision", async () => {
    const { service, records, events } = buildService([
      makeRule({
        ruleId: "pol_1",
        effect: "block",
        conditions: { categories: ["github"] },
        reason: "No GitHub writes."
      })
    ]);
    await expect(service.gateAction(gateInput())).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(records).toHaveLength(1);
    expect(records[0].enforced).toBe(true);
    expect(events[0].type).toBe("policy.decision.enforced");
  });

  it("the thrown error carries the rule explanation + matched rule id", async () => {
    const { service } = buildService([
      makeRule({
        ruleId: "pol_x",
        effect: "block",
        conditions: {},
        reason: "Blocked for a reason."
      })
    ]);
    await service.gateAction(gateInput()).catch((err: unknown) => {
      expect(err).toBeInstanceOf(PolicyBlockedError);
      const e = err as PolicyBlockedError;
      expect(e.explanation).toBe("Blocked for a reason.");
      expect(e.matchedRuleId).toBe("pol_x");
    });
  });
});

describe("PolicyService.gateAction — enforce-mode require_approval", () => {
  it("routes an approval and proceeds when approved", async () => {
    const { service, records } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: {} })
    ]);
    const router = vi.fn(async (): Promise<PolicyApprovalDisposition> => "approve");
    const result = await service.gateAction(gateInput({ approvalRouter: router }));
    expect(router).toHaveBeenCalledTimes(1);
    expect(result.enforced).toBe(true);
    expect(records[0].outcome).toBe("require_approval");
    expect((records[0].actionSnapshot as Record<string, unknown>).approvalDisposition).toBe("approve");
  });

  it("throws when the approval is rejected", async () => {
    const { service } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: {} })
    ]);
    const router = vi.fn(async (): Promise<PolicyApprovalDisposition> => "reject");
    await expect(
      service.gateAction(gateInput({ approvalRouter: router }))
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("throws when the approval expires (with an expiry explanation)", async () => {
    const { service } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: {}, reason: "Needs sign-off." })
    ]);
    const router = vi.fn(async (): Promise<PolicyApprovalDisposition> => "expired");
    await service.gateAction(gateInput({ approvalRouter: router })).catch((err: unknown) => {
      expect((err as PolicyBlockedError).explanation).toContain("expired");
    });
  });

  it("denies immediately on a scheduled turn without routing an approval", async () => {
    // A scheduled turn has no human to decide: the prompt would be delivered to
    // the scheduler's event consumer and the gateway would hold its response
    // until the approval TTL — past the scheduler's job timeout. The router
    // must never be called; the action denies at once with a clear explanation
    // and recorded evidence.
    const { service, records, warnings } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: {}, reason: "Needs sign-off." })
    ]);
    const router = vi.fn(async (): Promise<PolicyApprovalDisposition> => "approve");

    const error = await service
      .gateAction(gateInput({ turnContext: "scheduled", approvalRouter: router }))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PolicyBlockedError);
    expect((error as PolicyBlockedError).explanation).toContain("scheduled runs");
    expect(router).not.toHaveBeenCalled();
    expect(records[0].outcome).toBe("require_approval");
    expect((records[0].actionSnapshot as Record<string, unknown>).approvalDisposition).toBe("reject");
    expect(warnings.some((w) => w.msg.includes("scheduled turn"))).toBe(true);
  });

  it("degrades to a deny when no approval router is available", async () => {
    const { service, warnings } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: {} })
    ]);
    await expect(service.gateAction(gateInput({ approvalRouter: undefined }))).rejects.toBeInstanceOf(
      PolicyBlockedError
    );
    expect(warnings.some((w) => w.msg.includes("no approval router"))).toBe(true);
  });
});

describe("PolicyService.gateAction — evidence is fail-open", () => {
  it("a decision-store write failure never changes the gating outcome (block still throws)", async () => {
    const { service, warnings } = buildService(
      [makeRule({ ruleId: "pol_1", effect: "block", conditions: {} })],
      { fail: true }
    );
    await expect(service.gateAction(gateInput())).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(warnings.some((w) => w.msg.includes("failed to persist decision evidence"))).toBe(true);
  });

  it("a decision-store write failure never blocks an allow", async () => {
    const { service } = buildService(
      [makeRule({ ruleId: "pol_1", effect: "allow", conditions: {} })],
      { fail: true }
    );
    const result = await service.gateAction(gateInput());
    expect(result.enforced).toBe(false);
  });
});

describe("PolicyService.evaluate (simulator path)", () => {
  it("returns the matched rule's outcome without recording", async () => {
    const { service, records } = buildService([
      makeRule({ ruleId: "pol_1", effect: "require_approval", conditions: { categories: ["github"] } })
    ]);
    const evaluation = await service.evaluate("t1", {
      toolName: "github_write_file",
      category: "github",
      severity: "file_change",
      serverId: "github",
      turnContext: "interactive"
    });
    expect(evaluation.outcome).toBe("require_approval");
    expect(evaluation.gating).toBe(true);
    expect(records).toHaveLength(0);
  });
});

describe("PolicyService rule cache", () => {
  it("invalidate() forces a reload on the next evaluation", async () => {
    const ruleStore = fakeRuleStore([
      makeRule({ ruleId: "pol_1", effect: "block", conditions: {} })
    ]);
    const { store: decisions } = fakeDecisionStore();
    const { store: auditEvents } = fakeAuditStore();
    const service = new PolicyService({ rules: ruleStore, decisions, auditEvents });

    await service.evaluate("t1", {
      toolName: "x",
      category: null,
      severity: null,
      serverId: null,
      turnContext: null
    });
    // Cached — a second call within the TTL does not re-list.
    await service.evaluate("t1", {
      toolName: "x",
      category: null,
      severity: null,
      serverId: null,
      turnContext: null
    });
    expect(ruleStore.list).toHaveBeenCalledTimes(1);

    service.invalidate("t1");
    await service.evaluate("t1", {
      toolName: "x",
      category: null,
      severity: null,
      serverId: null,
      turnContext: null
    });
    expect(ruleStore.list).toHaveBeenCalledTimes(2);
  });
});
