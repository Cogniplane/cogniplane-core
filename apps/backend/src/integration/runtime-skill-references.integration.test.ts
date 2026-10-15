import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedSession, seedTenantGraph } from "./support/fixtures.js";

// Revision cleanup keeps every bundle these references name, so a missed live
// runtime would let cleanup delete a bundle that a running session still uses.
describe.skipIf(!adminDatabaseUrl())("active runtime skill references", () => {
  /** Start a runtime in its own session that loaded one skill, and return that session. */
  async function addRuntime(tenantId: string, userId: string, status: string, skillId: string, revisionId: number) {
    const sessionId = await seedSession(tenantId, userId);
    await superuserPool().query(
      `INSERT INTO runtime_sessions
         (session_id, tenant_id, user_id, runtime_id, workspace_path, runtime_version, status, manifest_metadata)
       VALUES ($1, $2, $3, $4, '/home/user/workspace', 'test', $5, $6)`,
      [sessionId, tenantId, userId, `runtime-${randomUUID()}`, status,
        JSON.stringify({ skills: [{ id: skillId, revisionId, bundleHash: `${skillId}-hash` }] })]
    );
    return sessionId;
  }

  test("lists the skills of starting, active, and terminating runtimes for the given tenant", async () => {
    const tenant = await seedTenantGraph();
    const other = await seedTenantGraph();
    const expected = [];
    for (const [revisionId, status] of ["starting", "active", "terminating", "inactive", "terminated"].entries()) {
      const sessionId = await addRuntime(tenant.tenantId, tenant.userId, status, `skill-${status}`, revisionId + 1);
      if (["starting", "active", "terminating"].includes(status)) {
        expected.push({ sessionId, skillId: `skill-${status}`, revisionId: revisionId + 1, bundleHash: `skill-${status}-hash` });
      }
    }
    await addRuntime(other.tenantId, other.userId, "active", "skill-other-tenant", 9);

    const store = new SkillRevisionStore(appPool(), new SkillConfigStore(appPool()));
    const references = await store.listActiveRuntimeSkillReferences(tenant.tenantId);

    const bySkill = (a: { skillId: string }, b: { skillId: string }) => a.skillId.localeCompare(b.skillId);
    expect([...references].sort(bySkill)).toEqual(expected.sort(bySkill));
  });
});
