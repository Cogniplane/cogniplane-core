import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("skill pending revisions", () => {
  test("counts only the selected tenant's pending revisions", async () => {
    const first = await seedTenantGraph();
    const second = await seedTenantGraph();
    const skillId = `shared-${randomUUID()}`;

    await superuserPool().query(
      `INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by)
       VALUES ($1, $3, 'First', $4), ($2, $3, 'Second', $5)`,
      [first.tenantId, second.tenantId, skillId, first.userId, second.userId]
    );
    await superuserPool().query(
      `INSERT INTO admin_skill_revisions
         (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by, review_status)
       VALUES ($1, $3, 1, 'inline', 'first-a', $4, 'pending_review'),
              ($1, $3, 2, 'inline', 'first-b', $4, 'pending_review'),
              ($2, $3, 1, 'inline', 'second-a', $5, 'active')`,
      [first.tenantId, second.tenantId, skillId, first.userId, second.userId]
    );

    const store = new SkillConfigStore(appPool());
    const firstSkill = (await store.listSkills(first.tenantId)).find((row) => row.skillId === skillId);
    const secondSkill = (await store.listSkills(second.tenantId)).find((row) => row.skillId === skillId);
    expect(firstSkill?.pendingRevisionCount).toBe(2);
    expect(secondSkill?.pendingRevisionCount).toBe(0);
  });

  test("excludes platform drafts from tenant review counts", async () => {
    const tenant = await seedTenantGraph();
    const skillId = `platform-${randomUUID()}`;
    await superuserPool().query(
      `INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by)
       VALUES ('system', $1, 'Platform', $2)`,
      [skillId, tenant.userId]
    );
    await superuserPool().query(
      `INSERT INTO admin_skill_revisions
       (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by, review_status)
       VALUES ('system', $1, 1, 'inline', 'platform-draft', $2, 'pending_review')`,
      [skillId, tenant.userId]
    );
    const store = new SkillConfigStore(appPool());
    const inherited = (await store.listSkills(tenant.tenantId)).find((row) => row.skillId === skillId);
    expect(inherited).toMatchObject({ isInherited: true, pendingRevisionCount: 0 });
    expect((await store.listSkills("system")).find((row) => row.skillId === skillId)?.pendingRevisionCount).toBe(1);
  });

});
