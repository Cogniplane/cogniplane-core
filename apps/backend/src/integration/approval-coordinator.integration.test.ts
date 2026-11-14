import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";

import { registerApprovalRoutes } from "../routes/approvals.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { createPolicyApprovalProof } from "../services/policy/policy-approval-proof.js";
import { SessionExecutionError, SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { ApprovalCoordinator, type ApprovalPublication } from "../services/runtime/approval-coordinator.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
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
      getDecided: approvals.getDecided.bind(approvals),
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


  // Each replica has its own coordinator and route over one database. The third
  // one starts after the decision, like a restarted process.
  async function replicas(options: { lease?: boolean } = {}) {
    const identity = { ...await seedTenantGraph(), turnId: "retry-turn" };
    // With a lease, the decision write needs the active turn lease of the row's runtime.
    const executions = new SessionExecutionStore(appPool(), "retry-owner");
    const execution = options.lease ? await executions.acquire(identity, 30_000) : null;
    if (execution) await executions.bindRuntime(execution, identity.runtimeId);
    const local = { validate: async () => {} };
    const approvals = new ApprovalStore(appPool());
    const deps = { approvals, auditEvents: new AuditEventStore(appPool()), logger: createSilentLogger(), ttlMs: 30_000 };
    const coordinators: ApprovalCoordinator[] = [];
    const apps: ReturnType<typeof Fastify>[] = [];
    const auth = { tenantId: identity.tenantId, userId: identity.userId };
    const replica = async () => {
      const coordinator = new ApprovalCoordinator(deps);
      const app = Fastify();
      app.addHook("preHandler", async (request) => {
        request.auth = { tenantId: auth.tenantId, userId: auth.userId, role: "member", isAdmin: false };
      });
      await registerApprovalRoutes(app, { approvals, sessions: new SessionStore(appPool()),
        runtimeAdapter: { resolveApproval: (input) => coordinator.decide(input) } });
      coordinators.push(coordinator);
      apps.push(app);
      return { coordinator, app };
    };
    const owner = await replica();
    const remote = await replica();
    const published: ApprovalPublication[] = [];
    const turn = owner.coordinator.openTurn({ identity, projectId: null, durableNative: true,
      signal: new AbortController().signal, hasLocalActor: () => true, validateLocalDecision: () => local.validate() });
    const waits: Promise<unknown>[] = [];
    const prompt = async (action: Parameters<typeof turn.request>[0]) => {
      const wait = turn.request(action, (notice) => { published.push(notice); });
      waits.push(wait);
      await vi.waitFor(() => { expect(published.filter((notice) => notice.name === "approval_required")).toHaveLength(waits.length); });
      const card = published.at(-1)!;
      if (card.name !== "approval_required") throw new Error("Expected an approval card");
      return { wait, approvalId: card.value.approvalId };
    };
    const post = (app: ReturnType<typeof Fastify>, approvalId: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/approvals/${approvalId}/decision`, payload });
    const audits = async (approvalId: string) => (await superuserPool().query<{ event_type: string }>(
      "SELECT event_type FROM audit_events WHERE approval_id = $1", [approvalId])).rows.map((row) => row.event_type);
    const close = async () => {
      for (const coordinator of coordinators) coordinator.close();
      await Promise.allSettled(waits);
      await Promise.all(apps.map((app) => app.close()));
    };
    return { identity, approvals, executions, execution, local, auth, owner, remote, replica, prompt, post, audits, close };
  }
  const execute = { name: "execute", kind: "command_execution" as const, args: { command: "pwd" } };
  const conflict = { error: "approval_conflict", message: "This approval already has a different decision." };

  test.each(["approve", "reject"] as const)("answers a repeated %s the same way on each replica and after a restart", async (decision) => {
    const h = await replicas();
    try {
      const { wait, approvalId } = await h.prompt(execute);
      const first = await h.post(h.remote.app, approvalId, { decision });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ status: "resolved" });
      await expect(wait).resolves.toBe(decision);
      const restarted = await h.replica();
      const opposite = decision === "approve" ? "reject" : "approve";
      for (const { app } of [h.owner, h.remote, restarted]) {
        const retry = await h.post(app, approvalId, { decision });
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual({ status: "resolved" });
        const turnScope = await h.post(app, approvalId, { decision, rememberForTurn: true });
        expect(turnScope.statusCode).toBe(decision === "approve" ? 409 : 200);
        const different = await h.post(app, approvalId, { decision: opposite });
        expect(different.statusCode).toBe(409);
        expect(different.json()).toEqual(conflict);
      }
      const otherUser = await seedUser();
      await seedMembership(h.identity.tenantId, otherUser);
      h.auth.userId = otherUser;
      expect((await h.post(restarted.app, approvalId, { decision })).json()).toEqual({ error: "approval_not_found" });
      h.auth.userId = h.identity.userId;
      h.auth.tenantId = (await seedTenantGraph()).tenantId;
      const otherTenant = await h.post(restarted.app, approvalId, { decision });
      expect(otherTenant.statusCode).toBe(404);
      expect(otherTenant.json()).toEqual({ error: "approval_not_found" });
      expect(await h.approvals.get(h.identity.tenantId, approvalId, h.identity.userId)).toMatchObject({
        status: decision === "approve" ? "approved" : "rejected", decision, rememberForTurn: false
      });
      expect(await h.audits(approvalId)).toEqual([decision === "approve" ? "approval.approved" : "approval.rejected"]);
    } finally { await h.close(); }
  });

  test.each(["approve", "reject"] as const)(
    "answers a repeated %s from the saved row after the owner's lease ends", async (decision) => {
      const h = await replicas({ lease: true });
      try {
        const { wait, approvalId } = await h.prompt(execute);
        expect((await h.post(h.remote.app, approvalId, { decision })).statusCode).toBe(200);
        // The owner's turn stops before its poll reads the row.
        await h.executions.release(h.execution!);
        h.local.validate = async () => { throw new SessionExecutionError("execution_stopped", 403); };
        const opposite = decision === "approve" ? "reject" : "approve";
        for (const { app } of [h.owner, h.remote]) {
          const retry = await h.post(app, approvalId, { decision });
          expect(retry.statusCode).toBe(200);
          expect(retry.json()).toEqual({ status: "resolved" });
          const different = await h.post(app, approvalId, { decision: opposite });
          expect(different.statusCode).toBe(409);
          expect(different.json()).toEqual(conflict);
        }
        await expect(wait).resolves.toBe(decision);
        expect(await h.approvals.get(h.identity.tenantId, approvalId, h.identity.userId)).toMatchObject({
          status: decision === "approve" ? "approved" : "rejected", decision
        });
        expect(await h.audits(approvalId)).toEqual([decision === "approve" ? "approval.approved" : "approval.rejected"]);
      } finally { await h.close(); }
    });

  test("returns 404 on each replica for an undecided approval after the owner's lease ends", async () => {
    const h = await replicas({ lease: true });
    try {
      const { approvalId } = await h.prompt(execute);
      await h.executions.release(h.execution!);
      h.local.validate = async () => { throw new SessionExecutionError("execution_stopped", 403); };
      for (const { app } of [h.owner, h.remote]) {
        const response = await h.post(app, approvalId, { decision: "approve" });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "approval_not_found" });
      }
      // The end of the lease expires the pending row (expire_stopped_execution_approvals).
      expect(await h.approvals.get(h.identity.tenantId, approvalId, h.identity.userId)).toMatchObject({
        status: "expired", decision: null
      });
      expect(await h.audits(approvalId)).toEqual([]);
    } finally { await h.close(); }
  });

  test("returns 404 for a pending approval past its expiry", async () => {
    const h = await replicas();
    try {
      const { approvalId } = await h.prompt(execute);
      await superuserPool().query("UPDATE approvals SET expires_at = NOW() - INTERVAL '1 minute' WHERE approval_id = $1",
        [approvalId]);
      const response = await h.post(h.remote.app, approvalId, { decision: "approve" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "approval_not_found" });
      expect(await h.audits(approvalId)).toEqual([]);
    } finally { await h.close(); }
  });

  test.each(["equivalent", "conflicting"] as const)("gives %s concurrent decisions one winner", async (mode) => {
    const h = await replicas();
    try {
      const { wait, approvalId } = await h.prompt(execute);
      const decisions = mode === "equivalent" ? ["approve", "approve"] as const : ["approve", "reject"] as const;
      const responses = await Promise.all([
        h.post(h.owner.app, approvalId, { decision: decisions[0] }),
        h.post(h.remote.app, approvalId, { decision: decisions[1] })
      ]);
      const stored = await h.approvals.get(h.identity.tenantId, approvalId, h.identity.userId);
      if (mode === "equivalent") {
        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      } else {
        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        const winner = decisions[responses.findIndex((response) => response.statusCode === 200)];
        expect(stored?.decision).toBe(winner);
      }
      await expect(wait).resolves.toBe(stored?.decision);
      expect(await h.audits(approvalId)).toEqual([stored?.decision === "approve" ? "approval.approved" : "approval.rejected"]);
    } finally { await h.close(); }
  });

  test("keeps a consumed Policy Center proof consumed after a repeated approval", async () => {
    const h = await replicas();
    try {
      const args = { name: "notes.md", content: "text" };
      const proof = createPolicyApprovalProof({ ...h.identity, toolContextId: "retry-context", toolCallId: "retry-call",
        toolName: "write_artifact", serverId: "tenant-managed", args, ruleId: null, explanation: "Review." });
      const { wait, approvalId } = await h.prompt({ name: "write_artifact", kind: "mcp_tool", args, policyApproval: proof,
        server: { id: "tenant-managed", mode: "managed" } });
      expect(approvalId).toBe(proof.approvalId);
      expect((await h.post(h.remote.app, approvalId, { decision: "approve" })).statusCode).toBe(200);
      await expect(wait).resolves.toBe("approve");
      expect(await h.approvals.consume(h.identity.tenantId, approvalId, h.identity.userId)).toBe(true);
      const consumedAt = async () => (await superuserPool().query<{ consumed_at: Date }>(
        "SELECT consumed_at FROM approvals WHERE approval_id = $1", [approvalId])).rows[0]!.consumed_at;
      const claimed = await consumedAt();
      const restarted = await h.replica();
      for (const { app } of [h.owner, h.remote, restarted]) {
        expect((await h.post(app, approvalId, { decision: "approve" })).statusCode).toBe(200);
      }
      expect(await h.approvals.consume(h.identity.tenantId, approvalId, h.identity.userId)).toBe(false);
      expect(await consumedAt()).toEqual(claimed);
      expect(await h.audits(approvalId)).toEqual(["approval.approved"]);
    } finally { await h.close(); }
  });
});
