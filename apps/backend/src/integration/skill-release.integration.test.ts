import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

async function seedRelease() {
  const tenant = await seedTenantGraph();
  const skillId = `release-${randomUUID()}`;
  const skills = new SkillConfigStore(appPool());
  const revisions = new SkillRevisionStore(appPool(), skills);
  const draft = async (label: string) => revisions.importSkillBundle(tenant.tenantId, {
    skillId,
    skillName: label,
    description: "Release test",
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
  const first = await draft("First");
  const activate = (skillRevisionId: number, audience?: "test-users" | "members") =>
    revisions.activateSkillRevision(tenant.tenantId, {
      skillId, skillRevisionId, audience, reviewedBy: tenant.userId, reviewNotes: null
    });
  await activate(first.revision.skillRevisionId, "members");
  const second = await draft("Second");
  return { ...tenant, skillId, skills, revisions, first, second, activate };
}

describe.skipIf(!adminDatabaseUrl())("atomic skill release", () => {
  test("changes revision and audience together and preserves publication for legacy callers", async () => {
    const seed = await seedRelease();
    const released = await seed.activate(seed.second.revision.skillRevisionId, "test-users");
    expect(released?.skill).toMatchObject({ enabled: true, isPublished: false, instructions: "Instructions for Second" });
    expect(released?.revision.reviewStatus).toBe("active");
    expect(released?.previousActiveRevisionId).toBe(seed.first.revision.skillRevisionId);
    expect((await seed.revisions.getSkillRevision(seed.tenantId, seed.skillId, seed.first.revision.skillRevisionId))?.reviewStatus).toBe("approved");
    await seed.activate(seed.first.revision.skillRevisionId, "members");
    expect((await seed.activate(seed.second.revision.skillRevisionId))?.skill.isPublished).toBe(true);
  });

  test("invalid metadata leaves the live revision and audience unchanged", async () => {
    const seed = await seedRelease();
    await superuserPool().query(
      "UPDATE admin_skill_revisions SET metadata = '{}'::jsonb WHERE skill_revision_id = $1",
      [seed.second.revision.skillRevisionId]
    );
    await expect(seed.activate(seed.second.revision.skillRevisionId, "test-users")).rejects.toThrow("missing activation metadata");
    expect(await seed.skills.getSkill(seed.tenantId, seed.skillId)).toMatchObject({
      activeRevisionId: seed.first.revision.skillRevisionId, isPublished: true, enabled: true
    });
  });

  test("a database error after revision updates rolls the entire release back", async () => {
    const seed = await seedRelease();
    class FailingReadStore extends SkillConfigStore {
      override async getSkill(tenantId: string, skillId: string, client?: PoolClient) {
        // Fail inside Postgres after both updates, before the transaction commits.
        if (client) await client.query("SELECT 1 / 0");
        return super.getSkill(tenantId, skillId, client);
      }
    }
    const failingRelease = new SkillRevisionStore(appPool(), new FailingReadStore(appPool()));
    await expect(failingRelease.activateSkillRevision(seed.tenantId, {
      skillId: seed.skillId, skillRevisionId: seed.second.revision.skillRevisionId,
      audience: "test-users", reviewedBy: seed.userId, reviewNotes: null
    })).rejects.toThrow("division by zero");
    expect(await seed.skills.getSkill(seed.tenantId, seed.skillId)).toMatchObject({
      activeRevisionId: seed.first.revision.skillRevisionId, isPublished: true, enabled: true
    });
    const revisions = await seed.revisions.listSkillRevisions(seed.tenantId, seed.skillId);
    expect(revisions.find((r) => r.skillRevisionId === seed.first.revision.skillRevisionId)?.reviewStatus).toBe("active");
    expect(revisions.find((r) => r.skillRevisionId === seed.second.revision.skillRevisionId)?.reviewStatus).toBe("pending_review");
  });

  test("rejects foreign and inherited revisions without changing their audience", async () => {
    const seed = await seedRelease();
    const other = await seedTenantGraph();
    expect(await seed.revisions.activateSkillRevision(other.tenantId, {
      skillId: seed.skillId, skillRevisionId: seed.second.revision.skillRevisionId,
      audience: "test-users", reviewedBy: other.userId, reviewNotes: null
    })).toBeNull();
    await superuserPool().query(
      `INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by)
       VALUES ('system', $1, 'Platform skill', $2)`,
      [seed.skillId, seed.userId]
    );
    const systemRevision = await superuserPool().query(
      `INSERT INTO admin_skill_revisions
       (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by, validation_status, metadata)
       VALUES ('system', $1, 1, 'inline', 'system', $2, 'validated', $3::jsonb) RETURNING skill_revision_id`,
      [seed.skillId, seed.userId, JSON.stringify({ skillName: "Platform", description: "Platform", instructions: "Platform" })]
    );
    const input = {
      skillId: seed.skillId, skillRevisionId: Number(systemRevision.rows[0].skill_revision_id),
      audience: "members" as const, reviewedBy: other.userId, reviewNotes: null
    };
    expect(await seed.revisions.activateSkillRevision(other.tenantId, input)).toBeNull();
    // A local row with the same ID must not accept a platform revision either.
    expect(await seed.revisions.activateSkillRevision(seed.tenantId, input)).toBeNull();
    expect(await seed.skills.getSkill(seed.tenantId, seed.skillId)).toMatchObject({
      activeRevisionId: seed.first.revision.skillRevisionId, isPublished: true
    });
  });

  test("concurrent releases keep one active revision with its chosen audience", async () => {
    const seed = await seedRelease();
    await Promise.all([
      seed.activate(seed.first.revision.skillRevisionId, "members"),
      seed.activate(seed.second.revision.skillRevisionId, "test-users")
    ]);
    const skill = await seed.skills.getSkill(seed.tenantId, seed.skillId);
    const active = (await seed.revisions.listSkillRevisions(seed.tenantId, seed.skillId)).filter((r) => r.reviewStatus === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.skillRevisionId).toBe(skill?.activeRevisionId);
    expect(skill?.isPublished).toBe(skill?.activeRevisionId === seed.first.revision.skillRevisionId);
  });
});
