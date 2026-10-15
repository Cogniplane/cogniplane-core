import { expect, test } from "vitest";

import { AdminConfigError } from "../admin-config-error.js";
import { FakePool } from "../../test-helpers/fake-pool.js";

import { SkillConfigStore } from "./skill-config-store.js";
import { SkillRevisionStore } from "./skill-revision-store.js";

test("SkillConfigStore prefers a tenant-owned legacy skill over a system skill", async () => {
  const pool = new FakePool().onQuery("FROM admin_skills AS skill", (text) => {
    expect(text).toContain("ORDER BY (skill.tenant_id = $2::text) DESC");
    return {
      rows: [
        {
          tenant_id: "tenant-1",
          skill_id: "shared-skill",
          skill_name: "Tenant skill",
          description: null,
          instructions: "Tenant instructions",
          version: 1,
          content_hash: "tenant-hash",
          enabled: true,
          is_published: true,
          created_by: "admin",
          created_at: "2026-07-09T00:00:00.000Z",
          updated_at: "2026-07-09T00:00:00.000Z",
          active_revision_id: 1,
          active_source_type: "zip",
          active_bundle_name: "shared-skill.zip",
          active_bundle_storage_uri: null,
          active_bundle_hash: "tenant-hash",
          active_validation_status: "valid",
          active_review_status: "active",
          active_associated_tool_ids: []
        }
      ],
      rowCount: 1
    };
  });

  const skill = await new SkillConfigStore(pool.asPool()).getSkill("tenant-1", "shared-skill");

  expect(skill).toMatchObject({
    skillId: "shared-skill",
    skillName: "Tenant skill",
    isInherited: false
  });
});

test("SkillConfigStore lists one tenant-preferred row per skill ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_skills AS skill", (text) => {
    expect(text).toContain("SELECT DISTINCT ON");
    expect(text).toContain("(skill.tenant_id = $2::text) DESC");
    return { rows: [], rowCount: 0 };
  });

  await expect(new SkillConfigStore(pool.asPool()).listSkills("tenant-1")).resolves.toEqual([]);
});

test("SkillRevisionStore rejects imports that reuse a system skill ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_skills", (_text, values) => {
    if (values.length === 2) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [{ exists: 1 }], rowCount: 1 };
  });
  const skillStore = new SkillConfigStore(pool.asPool());
  const revisions = new SkillRevisionStore(pool.asPool(), skillStore);
  const storeBundle = async () => ({ storageUri: null });

  await expect(
    revisions.importSkillBundle("tenant-1", {
      skillId: "system-skill",
      skillName: "System skill",
      description: "reserved",
      instructions: "instructions",
      sourceType: "zip",
      sourceLabel: "upload.zip",
      bundleName: "upload.zip",
      bundleHash: "hash",
      validationStatus: "valid",
      validationMessages: [],
      metadata: {},
      createdBy: "admin",
      storeBundle
    })
  ).rejects.toThrow(AdminConfigError);

  expect(pool.queries.some((query) => query.text.includes("INSERT INTO admin_skills"))).toBe(false);
});

test.each([
  ["disableSkill", (store: SkillConfigStore) => store.disableSkill("tenant-1", "notes")],
  ["setSkillPublished", (store: SkillConfigStore) => store.setSkillPublished("tenant-1", "notes", true)]
])("SkillConfigStore.%s returns the active revision content", async (_name, run) => {
  // The UPDATE returns a bare admin_skills row, which has no instructions or
  // content hash. The store must read the joined row again.
  const pool = new FakePool()
    .onQuery("UPDATE admin_skills", () => ({
      rows: [{ tenant_id: "tenant-1", skill_id: "notes", skill_name: "Notes", version: 2,
        enabled: false, is_published: true, active_revision_id: 9 }],
      rowCount: 1
    }))
    .onQuery("FROM admin_skills AS skill", () => ({
      rows: [{
        tenant_id: "tenant-1", skill_id: "notes", skill_name: "Notes", description: null,
        instructions: "Active instructions", version: 2, content_hash: "active-hash",
        enabled: false, is_published: true, created_by: "admin",
        created_at: "2026-10-13T00:00:00.000Z", updated_at: "2026-10-13T00:00:00.000Z",
        active_revision_id: 9, active_source_type: "inline", active_bundle_name: "notes",
        active_bundle_storage_uri: null, active_bundle_hash: "active-hash",
        active_validation_status: "valid", active_review_status: "active", active_associated_tool_ids: []
      }],
      rowCount: 1
    }));

  const skill = await run(new SkillConfigStore(pool.asPool()));

  expect(skill).toMatchObject({
    instructions: "Active instructions", contentHash: "active-hash",
    activeRevisionId: 9, activeReviewStatus: "active"
  });
});

test("SkillConfigStore.disableSkill returns null when the tenant does not own the skill", async () => {
  const pool = new FakePool().onQuery("UPDATE admin_skills", () => ({ rows: [], rowCount: 0 }));

  await expect(new SkillConfigStore(pool.asPool()).disableSkill("tenant-1", "system-skill")).resolves.toBeNull();
});
