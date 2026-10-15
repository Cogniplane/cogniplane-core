import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { SkillReleaseImpactStore, SkillReleaseSnapshotConflictError } from "../services/skills/skill-release-impact-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenantGraph, seedUser } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("organization skill release impact", () => {
  test("counts eligible members and configured references, then rejects stale release mutations", async () => {
    const seed = await seedTenantGraph();
    const member = await seedUser();
    await seedMembership(seed.tenantId, member);
    await superuserPool().query(`UPDATE tenant_memberships SET is_beta_tester=true
      WHERE tenant_id=$1 AND user_id=$2`, [seed.tenantId, seed.userId]);
    const skillId = `preview-${randomUUID()}`;
    const skills = new SkillConfigStore(appPool());
    const revisions = new SkillRevisionStore(appPool(), skills);
    const draft = await revisions.importSkillBundle(seed.tenantId, {
      skillId, skillName:"Preview skill", description:"Preview", instructions:"Follow these steps.",
      sourceType:"inline", sourceLabel:"preview", bundleName:skillId, bundleHash:"a".repeat(64),
      validationStatus:"validated", validationMessages:[], metadata:{}, createdBy:seed.userId,
      storeBundle:async()=>({storageUri:null})
    });
    const inheritedProject=`project-${randomUUID()}`;
    const selectedProject=`project-${randomUUID()}`;
    await superuserPool().query(`INSERT INTO projects(project_id,tenant_id,user_id,name,capability_selection)
      VALUES ($1,$3,$4,'Inherited',NULL),($2,$3,$4,'Selected',$5::jsonb)`,
    [inheritedProject,selectedProject,seed.tenantId,seed.userId,JSON.stringify({skillIds:[skillId],connectorIds:[]})]);
    await superuserPool().query(`INSERT INTO personal_capability_defaults(tenant_id,user_id,capability_selection)
      VALUES ($1,$2,$3::jsonb)`,[seed.tenantId,seed.userId,JSON.stringify({skillIds:[skillId],connectorIds:[]})]);
    const extraSession=await seedSession(seed.tenantId,member);
    await superuserPool().query(`UPDATE sessions SET capability_selection=$3::jsonb
      WHERE tenant_id=$1 AND session_id=$2`,[seed.tenantId,extraSession,JSON.stringify({skillIds:[skillId],connectorIds:[]})]);
    const impact=new SkillReleaseImpactStore(appPool());
    const before=await impact.preview(seed.tenantId,skillId,{action:"activate",
      revisionId:draft.revision.skillRevisionId,audience:"test-users"});
    expect(before).toMatchObject({current:{audience:"off",revisionId:null},
      proposed:{audience:"test-users",revisionId:draft.revision.skillRevisionId},
      members:{total:2,testUsers:1,gaining:1,losing:0},
      configuredReferences:{projects:{inherited:1,explicitSelected:1},
        personalDefaults:{inherited:1,explicitSelected:1},sessions:{inherited:1,explicitSelected:1}}});
    await revisions.activateSkillRevision(seed.tenantId,{skillId,skillRevisionId:draft.revision.skillRevisionId,
      reviewedBy:seed.userId,reviewNotes:null,audience:"test-users",expectedSnapshot:before.snapshot});
    await expect(revisions.activateSkillRevision(seed.tenantId,{skillId,skillRevisionId:draft.revision.skillRevisionId,
      reviewedBy:seed.userId,reviewNotes:null,audience:"members",expectedSnapshot:before.snapshot}))
      .rejects.toBeInstanceOf(SkillReleaseSnapshotConflictError);
    const broader=await impact.preview(seed.tenantId,skillId,{action:"audience",
      revisionId:draft.revision.skillRevisionId,audience:"members"});
    expect(broader.members).toMatchObject({gaining:1,losing:0});
    await skills.setSkillPublished(seed.tenantId,skillId,true,broader.snapshot);
    await expect(skills.disableSkill(seed.tenantId,skillId,broader.snapshot))
      .rejects.toBeInstanceOf(SkillReleaseSnapshotConflictError);
    const disable=await impact.preview(seed.tenantId,skillId,{action:"audience",
      revisionId:draft.revision.skillRevisionId,audience:"off"});
    expect(disable.members).toMatchObject({gaining:0,losing:2});
    await skills.disableSkill(seed.tenantId,skillId,disable.snapshot);
    expect((await impact.preview(seed.tenantId,skillId,{action:"audience",
      revisionId:draft.revision.skillRevisionId,audience:"members"})).proposed.audience).toBe("off");
  });
});
