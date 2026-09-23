import { describe, expect, test } from "vitest";

import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedMembership, seedRuntimeSession, seedTenant, seedUser } from "./support/fixtures.js";

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
      ttlMs: 60_000
    });

    expect(await contexts.extend(tenantId, context.toolContextId, 60_000)).not.toBeNull();

    const otherTenantId = await seedTenant();
    const otherUserId = await seedUser();
    await seedMembership(otherTenantId, otherUserId, "owner");
    expect(await contexts.extend(otherTenantId, context.toolContextId, 60_000)).toBeNull();

    expect(await executions.stop({ tenantId, sessionId: sessionId!, userId })).toBe(true);
    expect(await contexts.extend(tenantId, context.toolContextId, 60_000)).toBeNull();
  });
});
