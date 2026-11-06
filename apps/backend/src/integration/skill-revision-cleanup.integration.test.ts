import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";

import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

async function releaseActivation(activation: PoolClient, settled: Promise<unknown>): Promise<void> {
  let rollbackError: Error | undefined;
  try {
    await activation.query("ROLLBACK");
  } catch (error) {
    rollbackError = error as Error;
    throw error;
  } finally {
    activation.release(rollbackError);
    await settled;
  }
}

async function seedRevisions() {
  const tenant = await seedTenantGraph();
  const skillId = `cleanup-${randomUUID()}`;
  const skills = new SkillConfigStore(appPool());
  const revisions = new SkillRevisionStore(appPool(), skills);
  const draft = (label: string) => revisions.importSkillBundle(tenant.tenantId, {
    skillId,
    skillName: label,
    description: "Cleanup test",
    instructions: `Instructions for ${label}`,
    sourceType: "inline",
    sourceLabel: label,
    bundleName: label,
    bundleHash: label,
    validationStatus: "validated",
    validationMessages: [],
    metadata: {},
    createdBy: tenant.userId,
    storeBundle: async () => ({ storageUri: null })
  });
  const activate = (skillRevisionId: number) => revisions.activateSkillRevision(tenant.tenantId, {
    skillId, skillRevisionId, reviewedBy: tenant.userId, reviewNotes: null
  });
  return { ...tenant, skillId, skills, revisions, draft, activate };
}

describe.skipIf(!adminDatabaseUrl())("skill revision cleanup", () => {
  test("lists only the tenant's own revisions", async () => {
    const seed = await seedRevisions();
    const own = await seed.draft("Own");
    const system = await superuserPool().query<{ skill_revision_id: string }>(
      "SELECT skill_revision_id FROM admin_skill_revisions WHERE tenant_id = 'system'"
    );
    expect(system.rowCount).toBeGreaterThan(0);

    const listed = (await seed.revisions.listAllSkillRevisions(seed.tenantId)).map((revision) => revision.skillRevisionId);

    expect(listed).toContain(own.revision.skillRevisionId);
    for (const row of system.rows) expect(listed).not.toContain(Number(row.skill_revision_id));
  });

  test("never deletes a revision that became active after cleanup chose it", async () => {
    const seed = await seedRevisions();
    const first = await seed.draft("First");
    await seed.activate(first.revision.skillRevisionId);
    const second = await seed.draft("Second");
    await seed.activate(second.revision.skillRevisionId);
    // Cleanup saw `first` as inactive; an admin rolls back to it before the delete runs.
    await seed.activate(first.revision.skillRevisionId);

    await expect(seed.revisions.deleteSkillRevision(seed.tenantId, seed.skillId, first.revision.skillRevisionId))
      .resolves.toBeNull();
    expect(await seed.skills.getSkill(seed.tenantId, seed.skillId)).toMatchObject({
      activeRevisionId: first.revision.skillRevisionId,
      instructions: "Instructions for First"
    });

    // An inactive revision is still deleted.
    await expect(seed.revisions.deleteSkillRevision(seed.tenantId, seed.skillId, second.revision.skillRevisionId))
      .resolves.toMatchObject({ skillRevisionId: second.revision.skillRevisionId });
  });

  test("a delete waits for a running activation and then refuses the new active revision", async () => {
    const seed = await seedRevisions();
    const first = await seed.draft("First");
    await seed.activate(first.revision.skillRevisionId);
    const second = await seed.draft("Second");
    await seed.activate(second.revision.skillRevisionId);

    // Hold the admin_skills row lock as activateSkillRevision does, and make
    // `first` active again only after the delete has started.
    const activation = await superuserPool().connect();
    let settled: Promise<unknown> = Promise.resolve();
    try {
      await activation.query("BEGIN");
      await activation.query("SELECT 1 FROM admin_skills WHERE tenant_id = $1 AND skill_id = $2 FOR UPDATE",
        [seed.tenantId, seed.skillId]);
      const { rows } = await activation.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deletion = seed.revisions.deleteSkillRevision(seed.tenantId, seed.skillId, first.revision.skillRevisionId);
      settled = Promise.allSettled([deletion]);
      await vi.waitFor(async () => {
        const blocked = await superuserPool().query<{ count: string }>(`
          SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = 'cogniplane-integration-app-user'
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query LIKE '%FROM admin_skills%'
            AND query LIKE '%FOR UPDATE%'`, [rows[0]!.pid]);
        expect(Number(blocked.rows[0]!.count)).toBe(1);
      }, { timeout: 5_000 });
      await activation.query(`UPDATE admin_skill_revisions SET review_status = CASE
        WHEN skill_revision_id = $3 THEN 'active' ELSE 'approved' END
        WHERE tenant_id = $1 AND skill_id = $2`, [seed.tenantId, seed.skillId, first.revision.skillRevisionId]);
      await activation.query("UPDATE admin_skills SET active_revision_id = $3 WHERE tenant_id = $1 AND skill_id = $2",
        [seed.tenantId, seed.skillId, first.revision.skillRevisionId]);
      await activation.query("COMMIT");

      await expect(deletion).resolves.toBeNull();
    } finally {
      await releaseActivation(activation, settled);
    }
    expect(await seed.skills.getSkill(seed.tenantId, seed.skillId))
      .toMatchObject({ activeRevisionId: first.revision.skillRevisionId });
  });

  test("activation reports the previous active revision number", async () => {
    const seed = await seedRevisions();
    const first = await seed.draft("First");
    expect(await seed.activate(first.revision.skillRevisionId))
      .toMatchObject({ previousActiveRevisionId: null, previousActiveRevisionNumber: null });
    const second = await seed.draft("Second");
    expect(await seed.activate(second.revision.skillRevisionId)).toMatchObject({
      previousActiveRevisionId: first.revision.skillRevisionId,
      previousActiveRevisionNumber: first.revision.revisionNumber
    });
    // A rollback: the previous number is higher than the new one.
    const rollback = await seed.activate(first.revision.skillRevisionId);
    expect(rollback).toMatchObject({ previousActiveRevisionNumber: second.revision.revisionNumber });
    expect(rollback!.revision.revisionNumber).toBeLessThan(second.revision.revisionNumber);
  });

  test("disable and publish return the active revision content", async () => {
    const seed = await seedRevisions();
    const first = await seed.draft("First");
    await seed.activate(first.revision.skillRevisionId);

    const disabled = await seed.skills.disableSkill(seed.tenantId, seed.skillId);
    const published = await seed.skills.setSkillPublished(seed.tenantId, seed.skillId, true);

    for (const skill of [disabled, published]) {
      expect(skill).toMatchObject({
        instructions: "Instructions for First",
        contentHash: "First",
        activeRevisionId: first.revision.skillRevisionId
      });
    }
  });
});
