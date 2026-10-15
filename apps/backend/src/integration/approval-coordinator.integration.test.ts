import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";

import { registerApprovalRoutes } from "../routes/approvals.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { createPolicyApprovalProof } from "../services/policy/policy-approval-proof.js";
import { SessionStore } from "../services/session-store.js";
import { ApprovalCoordinator, type ApprovalPublication } from "../services/runtime/approval-coordinator.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedMembership, seedRuntimeSession, seedTenant, seedTenantGraph, seedUser } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("approval coordinator with Postgres", () => {
  test.each(["turn", "runtime"] as const)("keeps a later approval pending after delayed %s cleanup", async (scope) => {
    const identity = { ...await seedTenantGraph(), turnId: "stopped-turn" };
    const approvals = new ApprovalStore(appPool());
    const auditEvents = new AuditEventStore(appPool());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = {
      create: approvals.create.bind(approvals), get: approvals.get.bind(approvals), resolve: approvals.resolve.bind(approvals),
      expire: async (...args: Parameters<ApprovalStore["expire"]>) => {
        if (scope === "turn") await gate;
        return approvals.expire(...args);
      },
      listPending: async (...args: Parameters<ApprovalStore["listPending"]>) => {
        await gate;
        return approvals.listPending(...args);
      }
    };
    const coordinator = new ApprovalCoordinator({ approvals: delayed, auditEvents, logger: createSilentLogger(), ttlMs: 30_000 });
    const published: ApprovalPublication[] = [];
    const publish = (notice: ApprovalPublication) => { published.push(notice); };
    const options = { identity, projectId: null, durableNative: true, signal: new AbortController().signal,
      hasLocalActor: () => true, validateLocalDecision: async () => {} };
    const action = { name: "execute", kind: "command_execution" as const, args: { command: "pwd" } };
    const oldTurn = coordinator.openTurn(options);
    const oldWait = oldTurn.request(action, publish);
    let nextWait: Promise<unknown> | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const oldCard = published[0]!;
      if (oldCard.name !== "approval_required") throw new Error("Expected old approval card");
      if (scope === "turn") oldTurn.cancelAndExpire("turn_interrupted");
      else cleanup = coordinator.cancelPending(identity, "runtime_terminated");
      await expect(oldWait).resolves.toBe("reject");
      const runtimeId = scope === "turn" ? identity.runtimeId
        : await seedRuntimeSession(identity.tenantId, identity.userId, identity.sessionId);
      const nextTurn = coordinator.openTurn({ ...options, identity: { ...identity, runtimeId, turnId: "later-turn" },
        signal: new AbortController().signal });
      nextWait = nextTurn.request(action, publish);
      await vi.waitFor(() => expect(published).toHaveLength(2));
      const nextCard = published[1]!;
      if (nextCard.name !== "approval_required") throw new Error("Expected later approval card");
      release();
      await cleanup;
      await vi.waitFor(async () => {
        expect(await approvals.get(identity.tenantId, oldCard.value.approvalId, identity.userId)).toMatchObject({ status: "expired" });
      });
      expect(await approvals.get(identity.tenantId, nextCard.value.approvalId, identity.userId)).toMatchObject({ status: "pending" });
      expect(await coordinator.decide({ ...identity, approvalId: nextCard.value.approvalId, decision: "approve" })).toBe("resolved");
      await expect(nextWait).resolves.toBe("approve");
    } finally { release(); coordinator.close(); await Promise.all([oldWait, nextWait, cleanup]); }
  });

  test.each(["approve", "reject"] as const)("observes a remote %s and preserves turn memory", async (decision) => {
    const identity = { ...await seedTenantGraph(), turnId: "integration-turn" };
    const approvals = new ApprovalStore(appPool());
    const deps = { approvals, auditEvents: new AuditEventStore(appPool()), logger: createSilentLogger(), ttlMs: 30_000 };
    const owner = new ApprovalCoordinator(deps);
    const remote = new ApprovalCoordinator(deps);
    const published: ApprovalPublication[] = [];
    const publish = (notice: ApprovalPublication) => { published.push(notice); };
    const turn = owner.openTurn({ identity, projectId: null, durableNative: true, signal: new AbortController().signal,
      hasLocalActor: () => true, validateLocalDecision: async () => {} });
    const action = { name: "execute", kind: "command_execution" as const, args: { command: "pwd" } };
    const wait = turn.request(action, publish);
    try {
      await vi.waitFor(() => { expect(published).toHaveLength(1); });
      const card = published[0]!;
      if (card.name !== "approval_required") throw new Error("Expected an approval card");
      expect(await approvals.get(identity.tenantId, card.value.approvalId, identity.userId)).toMatchObject({ status: "pending" });
      expect(await remote.decide({ ...identity, approvalId: card.value.approvalId, decision, rememberForTurn: true })).toBe("resolved");
      await expect(wait).resolves.toBe(decision);
      expect(await approvals.get(identity.tenantId, card.value.approvalId, identity.userId)).toMatchObject({
        status: decision === "approve" ? "approved" : "rejected", rememberForTurn: decision === "approve"
      });
      const next = turn.request(action, publish);
      if (decision === "approve") {
        await expect(next).resolves.toBe("approve");
        expect(published).toHaveLength(1);
      } else {
        await vi.waitFor(() => { expect(published).toHaveLength(2); });
        turn.cancelLocal();
        await expect(next).resolves.toBe("reject");
      }
    } finally {
      owner.close(); remote.close();
      await wait;
    }
  });

  test("keeps historical artifact copy identical in events, database, HTTP reload and pending reuse", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const session = await new SessionStore(appPool()).create(tenantId, userId, "Artifact approval");
    const sessionId = session.sessionId;
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    const identity = { tenantId, userId, sessionId, runtimeId, turnId: "artifact-turn" };
    const approvals = new ApprovalStore(appPool());
    const coordinator = new ApprovalCoordinator({ approvals, auditEvents: new AuditEventStore(appPool()),
      logger: createSilentLogger(), ttlMs: 30_000 });
    const published: ApprovalPublication[] = [];
    const publish = (notice: ApprovalPublication) => { published.push(notice); };
    const options = { identity, projectId: null, durableNative: true, signal: new AbortController().signal,
      hasLocalActor: () => true, validateLocalDecision: async () => {} };
    const args = { name: "report.md", content: "é🙂", toolContextId: "private-context" };
    const proof = createPolicyApprovalProof({ ...identity, toolContextId: "private-context", toolCallId: "artifact-call",
      toolName: "write_artifact", serverId: "tenant-managed", args, ruleId: "old-rule", explanation: "Original reason." });
    const action = { name: "write_artifact", kind: "mcp_tool" as const, args, policyApproval: proof,
      server: { id: "tenant-managed", mode: "managed" as const } };
    const firstTurn = coordinator.openTurn(options);
    const first = firstTurn.request(action, publish);
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = { tenantId: identity.tenantId, userId: identity.userId, role: "member", isAdmin: false };
    });
    await registerApprovalRoutes(app, { approvals, sessions: new SessionStore(appPool()),
      runtimeAdapter: { resolveApproval: (input) => coordinator.decide(input) } });
    let replay: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => { expect(published).toHaveLength(1); });
      const stored = (await approvals.get(identity.tenantId, proof.approvalId, identity.userId))!;
      const copy = { title: stored.title, summary: stored.summary };
      expect(copy.title).toBe('Save "report.md" to Artifacts');
      expect(copy.summary).toContain("6 bytes of inline text");
      expect(copy.summary).toContain("Reason: Original reason.");
      expect(copy.summary).not.toContain(args.content);
      expect(copy.summary).not.toContain(args.toolContextId);
      expect(published[0]).toMatchObject({ name: "approval_required", value: copy });
      const reload = await app.inject({ method: "GET", url: `/sessions/${identity.sessionId}/approvals` });
      expect(reload.statusCode).toBe(200);
      expect(reload.json().approvals).toEqual([expect.objectContaining(copy)]);
      firstTurn.cancelLocal();
      await expect(first).resolves.toBe("reject");
      const next = coordinator.openTurn({ ...options, identity: { ...identity, turnId: "artifact-replay" } });
      replay = next.request({ ...action, policyApproval: { ...proof, explanation: "Changed current reason." } }, publish);
      await vi.waitFor(() => { expect(published).toHaveLength(2); });
      expect(published[1]).toMatchObject({ name: "approval_required", value: copy });
      expect((await approvals.listPending(identity.tenantId, identity.sessionId, identity.userId)))
        .toEqual([expect.objectContaining(copy)]);
      const decision = await app.inject({ method: "POST", url: `/approvals/${proof.approvalId}/decision`,
        payload: { decision: "approve" } });
      expect(decision.statusCode).toBe(200);
      expect(decision.json()).toEqual({ status: "resolved" });
      await expect(replay).resolves.toBe("approve");
      expect((await app.inject({ method: "GET", url: `/sessions/${identity.sessionId}/approvals` })).json().approvals)
        .toEqual([]);
    } finally {
      coordinator.close();
      await Promise.all([first, replay]);
      await app.close();
    }
  });

});
