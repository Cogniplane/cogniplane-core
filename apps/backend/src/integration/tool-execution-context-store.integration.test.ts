import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
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
});
