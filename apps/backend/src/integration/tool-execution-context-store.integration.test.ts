import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { ToolContextUnavailableError, ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedRuntimeSession, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("tool execution context store", () => {
  test("extends only while the project execution is active and tenant is visible", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "owner");

    const projects = new ProjectStore(appPool());
    const project = await projects.create(tenantId, userId, "Context extension test");
    const sessionId = await projects.createSession(tenantId, userId, project.projectId, "Session");
    expect(sessionId).toBeTruthy();

    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId!);
    const executions = new SessionExecutionStore(appPool());
    const execution = await executions.acquire(
      { tenantId, sessionId: sessionId!, userId },
      60_000
    );
    await executions.bindRuntime(execution, runtimeId);

    const contexts = new ToolExecutionContextStore(appPool());
    const context = await contexts.create({
      tenantId,
      sessionId: sessionId!,
      userId,
      runtimeId,
      runtimePolicyId: "integration-test-policy",
      messageId: null,
      metadata: { executionId: execution.executionId },
      ownerSecurityVersion: null,
      ttlMs: 60_000
    });

    const databaseTimeMs = async () => {
      const { rows } = await superuserPool().query<{ now: Date }>("SELECT clock_timestamp() AS now");
      return rows[0]!.now.getTime();
    };
    const before = await databaseTimeMs();
    const renewed = await contexts.extend(tenantId, context.toolContextId, 300_000);
    const after = await databaseTimeMs();
    expect(renewed).not.toBeNull();
    expect(Date.parse(renewed!)).toBeGreaterThanOrEqual(before + 300_000);
    expect(Date.parse(renewed!)).toBeLessThanOrEqual(after + 300_000);
    expect(Date.parse(renewed!) - Date.parse(context.expiresAt)).toBeGreaterThan(230_000);
    expect((await contexts.get(tenantId, context.toolContextId))?.expiresAt).toBe(renewed);

    const expired = await contexts.create({
      tenantId, sessionId: sessionId!, userId, runtimeId,
      runtimePolicyId: "integration-test-policy", messageId: null,
      metadata: { executionId: execution.executionId }, ownerSecurityVersion: null, ttlMs: -60_000
    });
    expect(await contexts.extend(tenantId, expired.toolContextId, 300_000)).toBeNull();
    const persisted = await superuserPool().query(
      "SELECT expires_at FROM tool_execution_contexts WHERE tool_context_id = $1", [expired.toolContextId]
    );
    expect(persisted.rows[0].expires_at.toISOString()).toBe(expired.expiresAt);

    const otherTenantId = await seedTenant();
    const otherUserId = await seedUser();
    await seedMembership(otherTenantId, otherUserId, "owner");
    expect(await contexts.extend(otherTenantId, context.toolContextId, 60_000)).toBeNull();

    expect(await contexts.liveness(tenantId, context.toolContextId)).toBe("live");
    expect(await executions.stop({ tenantId, sessionId: sessionId!, userId })).toBe(true);
    expect(await contexts.extend(tenantId, context.toolContextId, 60_000)).toBeNull();
    // The runtime loop stops the turn too; the context of a WorkOS owner has no security version.
    expect(await contexts.liveness(tenantId, context.toolContextId)).toBe("ended");
  });

  // The runtime reads `liveness` at each model start and before each native tool
  // (deep-agents-runtime-adapter.ts). It must agree with `get`, which the
  // gateway uses, and tell a security change from the other ends.
  test("liveness agrees with get, and names a security change of the owner", async () => {
    const boot = await bootstrapLocalTenant(superuserPool(), "https://app.test", {
      tenantName: "Liveness", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
    });
    const { tenantId, userId } = boot;
    const version = async () => (await superuserPool().query(
      "SELECT security_version FROM local_identities WHERE user_id = $1", [userId])).rows[0].security_version as number;
    const contexts = new ToolExecutionContextStore(appPool());
    const scheduledContext = async (ownerSecurityVersion: number | null, ttlMs = 300_000) => {
      const sessionId = await seedSession(tenantId, userId);
      const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
      return (await contexts.create({
        tenantId, sessionId, userId, runtimeId, runtimePolicyId: "integration-test-policy", messageId: null,
        metadata: { turnContext: "scheduled" }, ownerSecurityVersion, ttlMs
      })).toolContextId;
    };
    const both = async (toolContextId: string) => ({
      liveness: await contexts.liveness(tenantId, toolContextId),
      found: (await contexts.get(tenantId, toolContextId)) !== null
    });

    const live = await scheduledContext(await version());
    const expired = await scheduledContext(await version(), -60_000);
    const unversioned = await scheduledContext(null);
    expect(await both(live)).toEqual({ liveness: "live", found: true });
    expect(await both(expired)).toEqual({ liveness: "ended", found: false });
    // A local owner's context with no version counts as a change.
    expect(await both(unversioned)).toEqual({ liveness: "security_change", found: false });
    expect(await contexts.liveness(tenantId, "ctx_missing")).toBe("ended");
    // Another tenant sees no row.
    expect(await contexts.liveness(await seedTenant(), live)).toBe("ended");

    await superuserPool().query(
      "UPDATE local_identities SET security_version = security_version + 1 WHERE user_id = $1", [userId]);

    expect(await both(live)).toEqual({ liveness: "security_change", found: false });
    // The change is the reason, also when the TTL expired too.
    expect(await both(expired)).toEqual({ liveness: "security_change", found: false });
    expect(await both(await scheduledContext(await version()))).toEqual({ liveness: "live", found: true });
  });

  // The gateway can hold a queued call of a scheduled turn after the turn
  // ended. The context names the execution (scheduler-worker.ts), so a lookup
  // after a stop, a release, an expiry or a newer execution refuses it.
  test("a scheduled context is live only while its execution holds the lease", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = (await new SessionStore(appPool())
      .create(tenantId, userId, "[Scheduled] Digest", { purpose: "scheduled" })).sessionId;
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    const actor = { tenantId, sessionId, userId };
    const caps = { perUser: 5, perTenant: 50 };
    const worker = new SessionExecutionStore(appPool(), "scheduler-replica");
    const requests = new SessionExecutionStore(appPool(), "request-replica");
    const contexts = new ToolExecutionContextStore(appPool());

    const createContext = (executionId: string, contextRuntimeId = runtimeId) => contexts.create({
      tenantId, sessionId, userId, runtimeId: contextRuntimeId, runtimePolicyId: "integration-test-policy",
      messageId: null, metadata: { executionId, turnContext: "scheduled" }, ownerSecurityVersion: null, ttlMs: 300_000
    });
    // What the scheduler does for each run: lease, runtime, then context.
    const scheduledRun = async () => {
      const execution = await worker.acquire(actor, 60_000, caps, "scheduled");
      await worker.bindRuntime(execution, runtimeId);
      return { execution, context: await createContext(execution.executionId) };
    };
    // Every lookup the gateway and the runtime use. `extend` changes only the
    // expiry of a live row, so the check can repeat.
    const lookups = async (toolContextId: string) => ({
      get: (await contexts.get(tenantId, toolContextId))?.toolContextId ?? null,
      owned: (await contexts.getOwned(tenantId, toolContextId, userId))?.toolContextId ?? null,
      require: await contexts.require(tenantId, toolContextId)
        .then(context => context.toolContextId, (error: unknown) => error instanceof ToolContextUnavailableError ? "unavailable" : error),
      liveness: await contexts.liveness(tenantId, toolContextId),
      extended: (await contexts.extend(tenantId, toolContextId, 300_000)) !== null
    });
    const live = (toolContextId: string) =>
      ({ get: toolContextId, owned: toolContextId, require: toolContextId, liveness: "live", extended: true });
    const ended = { get: null, owned: null, require: "unavailable", liveness: "ended", extended: false };
    const latest = async () => (await contexts.findLatestActiveBySession(tenantId, sessionId))?.toolContextId ?? null;

    // Live during the lease. A context of another runtime is not.
    const stopped = await scheduledRun();
    expect(await lookups(stopped.context.toolContextId)).toEqual(live(stopped.context.toolContextId));
    expect(await latest()).toBe(stopped.context.toolContextId);
    const otherRuntime = await createContext(stopped.execution.executionId, await seedRuntimeSession(tenantId, userId, sessionId));
    expect(await lookups(otherRuntime.toolContextId)).toEqual(ended);
    expect(await latest()).toBe(stopped.context.toolContextId);

    // The owner's Stop, from another replica.
    expect(await requests.stopAndGetOwner(actor)).toMatchObject({ executionId: stopped.execution.executionId });
    expect(await lookups(stopped.context.toolContextId)).toEqual(ended);
    expect(await latest()).toBeNull();
    // The worker releases the stopped lease when its runtime is gone; the context stays ended.
    await worker.release(stopped.execution);
    expect(await lookups(stopped.context.toolContextId)).toEqual(ended);

    // The normal end of a run.
    const released = await scheduledRun();
    expect(await lookups(released.context.toolContextId)).toEqual(live(released.context.toolContextId));
    await worker.release(released.execution);
    expect(await lookups(released.context.toolContextId)).toEqual(ended);
    expect(await latest()).toBeNull();

    // A lease that the worker stopped renewing (the abort grace of the watchdog).
    const expired = await scheduledRun();
    expect(await lookups(expired.context.toolContextId)).toEqual(live(expired.context.toolContextId));
    await superuserPool().query(
      "UPDATE session_executions SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE execution_id = $1",
      [expired.execution.executionId]);
    expect(await lookups(expired.context.toolContextId)).toEqual(ended);
    expect(await latest()).toBeNull();

    // The next execution of the session, on the same runtime, replaces the
    // expired one. Its context works, and the old one is not a fallback.
    const next = await scheduledRun();
    expect(next.execution.executionId).not.toBe(expired.execution.executionId);
    expect(await lookups(expired.context.toolContextId)).toEqual(ended);
    expect(await lookups(next.context.toolContextId)).toEqual(live(next.context.toolContextId));
    expect(await latest()).toBe(next.context.toolContextId);
    await worker.release(next.execution);
    expect(await latest()).toBeNull();
    // All the old contexts still have time left on their TTL: only the lease ended them.
    const ttls = await superuserPool().query<{ live: boolean }>(
      "SELECT expires_at > NOW() AS live FROM tool_execution_contexts WHERE tool_context_id = ANY($1::text[])",
      [[stopped, released, expired, next].map(run => run.context.toolContextId)]);
    expect(ttls.rows.map(row => row.live)).toEqual([true, true, true, true]);
  });

  // Rollout: a scheduled context that a version before scheduled leases wrote
  // names no execution. It stays live until its TTL (toolContextExecutionSql).
  test("a scheduled context without an execution id lives until its TTL, and an interactive one does not", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    const contexts = new ToolExecutionContextStore(appPool());
    const create = (metadata: Record<string, unknown>) => contexts.create({
      tenantId, sessionId, userId, runtimeId, runtimePolicyId: "integration-test-policy",
      messageId: null, metadata, ownerSecurityVersion: null, ttlMs: 300_000
    });
    const legacy = await create({ turnContext: "scheduled" });
    const interactive = await create({ turnContext: "interactive" });
    expect(await contexts.liveness(tenantId, legacy.toolContextId)).toBe("live");
    expect(await contexts.get(tenantId, legacy.toolContextId)).not.toBeNull();
    expect(await contexts.liveness(tenantId, interactive.toolContextId)).toBe("ended");
    expect(await contexts.get(tenantId, interactive.toolContextId)).toBeNull();
  });
});
