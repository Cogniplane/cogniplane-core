import { describe, expect, test, vi } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { OrganizationSkillSubmissionStore, SubmissionAccessError, SubmissionConflictError,
  SubmissionNotFoundError } from "../services/skills/organization-skill-submission-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const source = { kind:"inline" as const, name:"notes", description:"Write notes", instructions:"Write short notes." };
const submissions = () => new OrganizationSkillSubmissionStore(appPool());
const personal = () => new PersonalSkillStore(appPool());

async function setup() {
  const tenant=await seedTenant(), otherTenant=await seedTenant();
  const author=await seedUser(), admin=await seedUser(), member=await seedUser();
  await seedMembership(tenant,author); await seedMembership(tenant,admin,"admin");
  await seedMembership(tenant,member); await seedMembership(otherTenant,member,"admin");
  const skill=await personal().create(tenant,author,source);
  return {tenant,otherTenant,author,admin,member,skill};
}

describe.skipIf(!adminDatabaseUrl())("organization skill submissions", () => {
  test("stores scoped author updates and reads one event without changing older unread events", async () => {
    const x=await setup(), store=submissions();
    const first=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    await store.decide(x.tenant,x.admin,first,{version:1,action:"request_changes",reason:"Add a step",
      organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null});
    const revised=await personal().update(x.tenant,x.author,x.skill.id,{...source,instructions:"Add a step."},1);
    await store.resubmit(x.tenant,x.author,first,2,revised.latest.revision,"");
    await store.decide(x.tenant,x.admin,first,{version:3,action:"decline",reason:"Still incomplete",
      organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null});
    const page=await store.listUpdates(x.tenant,x.author,1);
    expect(page).toMatchObject({unreadCount:2,nextCursor:expect.any(String)});
    expect(page.updates).toMatchObject([{kind:"declined",feedback:"Still incomplete",readAt:null}]);
    const older=await store.listUpdates(x.tenant,x.author,1,page.nextCursor!);
    expect(older.updates).toMatchObject([{kind:"changes_requested",feedback:"Add a step",readAt:null}]);
    await expect(store.listUpdates(x.tenant,x.member,1,page.nextCursor!)).rejects.toBeInstanceOf(SubmissionNotFoundError);
    expect((await store.listUpdates(x.tenant,x.member,20)).updates).toEqual([]);
    expect((await store.listUpdates(x.otherTenant,x.member,20)).updates).toEqual([]);
    await expect(store.readUpdate(x.tenant,x.member,page.updates[0].id)).rejects.toBeInstanceOf(SubmissionNotFoundError);
    await expect(store.readUpdate(x.otherTenant,x.member,page.updates[0].id)).rejects.toBeInstanceOf(SubmissionNotFoundError);
    expect((await store.readUpdate(x.tenant,x.author,page.updates[0].id)).unreadCount).toBe(1);
    expect((await store.readUpdate(x.tenant,x.author,page.updates[0].id)).unreadCount).toBe(1);
    await expect(superuserPool().query(`UPDATE organization_skill_author_updates SET skill_name='changed'
      WHERE tenant_id=$1 AND update_id=$2`,[x.tenant,page.updates[0].id])).rejects.toThrow("immutable");
    expect((await store.listUpdates(x.tenant,x.author,20)).updates.find(update=>update.id===older.updates[0].id)?.readAt).toBeNull();
    expect((await store.get(x.tenant,x.author,first,false)).updates).toHaveLength(2);
  });

  test("records an ordinary skill-library activation of an accepted revision", async () => {
    const x=await setup(), store=submissions();
    const id=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    await store.decide(x.tenant,x.admin,id,{version:1,action:"accept",reason:null,
      organizationSkillId:"team-notes",organizationSkillName:"Team notes",expectedOrganizationVersion:null});
    const accepted=await store.get(x.tenant,x.admin,id,true);
    const revisionId=accepted.latest.acceptedRevisionId!;
    const revisions=new SkillRevisionStore(appPool(),new SkillConfigStore(appPool()));
    await revisions.activateSkillRevision(x.tenant,{skillId:"team-notes",skillRevisionId:revisionId,
      reviewedBy:x.admin,reviewNotes:null,audience:"members"});
    expect((await store.listUpdates(x.tenant,x.author,20)).updates).toMatchObject([
      {kind:"released",audience:"members",organizationRevisionId:revisionId},
      {kind:"accepted",organizationRevisionId:revisionId}]);
  });

  test("attributes a library release of an edited accepted draft to its author", async () => {
    const x=await setup(), store=submissions();
    const id=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    await store.decide(x.tenant,x.admin,id,{version:1,action:"accept",reason:null,
      organizationSkillId:"team-notes",organizationSkillName:"Team notes",expectedOrganizationVersion:null});
    const revisions=new SkillRevisionStore(appPool(),new SkillConfigStore(appPool()));
    const edited=await revisions.importSkillBundle(x.tenant,{skillId:"team-notes",skillName:"Edited team notes",
      description:"Edited",instructions:"Admin edits.",sourceType:"inline",sourceLabel:"edited",bundleName:"team-notes",
      bundleHash:"a".repeat(64),validationStatus:"validated",validationMessages:[],createdBy:x.admin,
      metadata:{organizationSubmissionId:"spoofed",organizationSubmissionAttempt:999},
      storeBundle:async()=>({storageUri:null})});
    const revisionId=edited.revision.skillRevisionId;
    expect(edited.revision.metadata).toMatchObject({organizationSubmissionId:id,organizationSubmissionAttempt:1});
    await revisions.activateSkillRevision(x.tenant,{skillId:"team-notes",skillRevisionId:revisionId,
      reviewedBy:x.admin,reviewNotes:null,audience:"test-users"});
    expect((await store.listUpdates(x.tenant,x.author,20)).updates[0]).toMatchObject({
      kind:"released",skillName:"Edited team notes",audience:"test-users",organizationRevisionId:revisionId});
    await revisions.activateSkillRevision(x.tenant,{skillId:"team-notes",skillRevisionId:revisionId,
      reviewedBy:x.admin,reviewNotes:null,audience:"members"});
    expect((await store.listUpdates(x.tenant,x.author,20)).updates.filter(update=>update.kind==="released"))
      .toMatchObject([{audience:"members"},{audience:"test-users"}]);
    // The same revision and audience again does not notify the author a second time,
    // also after a cycle back to an audience that was already notified.
    for (const audience of ["members","test-users"] as const) {
      await revisions.activateSkillRevision(x.tenant,{skillId:"team-notes",skillRevisionId:revisionId,
        reviewedBy:x.admin,reviewNotes:null,audience});
    }
    expect((await store.listUpdates(x.tenant,x.author,20)).updates.filter(update=>update.kind==="released")).toHaveLength(2);
    const unrelated=await revisions.importSkillBundle(x.tenant,{skillId:"team-notes",skillName:"Unrelated draft",
      description:"New",instructions:"New instructions.",sourceType:"inline",sourceLabel:"new",bundleName:"team-notes",
      bundleHash:"b".repeat(64),validationStatus:"validated",validationMessages:[],createdBy:x.admin,
      metadata:{organizationSubmissionId:id,organizationSubmissionAttempt:1},
      storeBundle:async()=>({storageUri:null})});
    expect(unrelated.revision.metadata).not.toHaveProperty("organizationSubmissionId");
    await revisions.activateSkillRevision(x.tenant,{skillId:"team-notes",skillRevisionId:unrelated.revision.skillRevisionId,
      reviewedBy:x.admin,reviewNotes:null,audience:"members"});
    expect((await store.listUpdates(x.tenant,x.author,20)).updates.filter(update=>update.kind==="released")).toHaveLength(2);
  });

  test("keeps a frozen revision, hides it from other members and tenants, and handles withdrawal", async () => {
    const x=await setup(), store=submissions();
    const id=await store.create(x.tenant,x.author,x.skill.id,1,"Please review",null);
    expect((await store.get(x.tenant,x.author,id,false)).latest.snapshot.content.instructions).toBe(source.instructions);
    expect((await store.get(x.tenant,x.admin,id,true)).authorEmail).toContain("@example.test");
    await expect(store.get(x.tenant,x.member,id,false)).rejects.toBeInstanceOf(SubmissionNotFoundError);
    await expect(store.get(x.otherTenant,x.member,id,true)).rejects.toBeInstanceOf(SubmissionNotFoundError);
    expect(await store.list(x.tenant,x.member,false)).toEqual([]);
    await expect(store.list(x.tenant,x.member,true)).rejects.toBeInstanceOf(SubmissionAccessError);
    await personal().update(x.tenant,x.author,x.skill.id,{...source,instructions:"Changed later"},1);
    expect((await store.get(x.tenant,x.admin,id,true)).latest.snapshot.content.instructions).toBe(source.instructions);
    await store.withdraw(x.tenant,x.author,id,1);
    expect((await store.get(x.tenant,x.author,id,false)).status).toBe("withdrawn");
    await expect(store.withdraw(x.tenant,x.author,id,1)).rejects.toBeInstanceOf(SubmissionConflictError);
  });

  test("preserves attempts and accepted draft after source deletion and member departure", async () => {
    const x=await setup(), store=submissions();
    const id=await store.create(x.tenant,x.author,x.skill.id,1,"First",null);
    await store.decide(x.tenant,x.admin,id,{version:1,action:"request_changes",reason:"Clarify steps",organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null});
    const revised=await personal().update(x.tenant,x.author,x.skill.id,{...source,instructions:"Clarified steps"},1);
    await store.resubmit(x.tenant,x.author,id,2,revised.latest.revision,"Updated");
    const history=await store.get(x.tenant,x.admin,id,true);
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts[1].feedback).toBe("Clarify steps");
    await store.decide(x.tenant,x.admin,id,{version:3,action:"accept",reason:null,organizationSkillId:"team-notes",
      organizationSkillName:"Team notes",expectedOrganizationVersion:null});
    const accepted=await store.get(x.tenant,x.admin,id,true);
    expect(accepted).toMatchObject({status:"accepted",acceptedOrganizationSkillId:"team-notes",
      organizationSkill:{enabled:false,isPublished:false,activeRevisionId:null}});
    expect(accepted.latest.acceptedRevisionId).toBeTypeOf("number");
    await personal().remove(x.tenant,x.author,x.skill.id,revised.version);
    expect((await store.get(x.tenant,x.admin,id,true)).latest.snapshot.content.instructions).toBe("Clarified steps");
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[x.tenant,x.author]);
    await expect(store.get(x.tenant,x.author,id,false)).rejects.toBeInstanceOf(SubmissionAccessError);
    expect((await store.get(x.tenant,x.admin,id,true)).attempts).toHaveLength(2);
  });

  test("rejects name collision, rolls back failed audit, and releases the exact draft and audience", async () => {
    const x=await setup(), store=submissions();
    const first=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    await store.decide(x.tenant,x.admin,first,{version:1,action:"accept",reason:null,organizationSkillId:"team-notes",
      organizationSkillName:"Team notes",expectedOrganizationVersion:null});
    const accepted=await store.get(x.tenant,x.admin,first,true);
    const draft=accepted.organizationSkill!.currentDraftRevisionId!;
    const second=await store.create(x.tenant,x.author,x.skill.id,1,"Another",null);
    await expect(store.decide(x.tenant,x.admin,second,{version:1,action:"accept",reason:null,organizationSkillId:"team-notes",
      organizationSkillName:"Team notes 2",expectedOrganizationVersion:null})).rejects.toBeInstanceOf(SubmissionConflictError);
    const fail=vi.spyOn(AuditEventStore,"createInTransaction").mockRejectedValueOnce(new Error("audit failed"));
    try { await expect(store.release(x.tenant,x.admin,first,{expectedOrganizationVersion:0,expectedActiveRevisionId:null,
      expectedDraftRevisionId:draft,audience:"test-users"})).rejects.toThrow("audit failed"); } finally { fail.mockRestore(); }
    expect((await store.get(x.tenant,x.admin,first,true)).organizationSkill?.activeRevisionId).toBeNull();
    await expect(store.release(x.tenant,x.admin,first,{expectedOrganizationVersion:0,expectedActiveRevisionId:null,
      expectedDraftRevisionId:draft+1,audience:"members"})).rejects.toBeInstanceOf(SubmissionConflictError);
    await store.release(x.tenant,x.admin,first,{expectedOrganizationVersion:0,expectedActiveRevisionId:null,
      expectedDraftRevisionId:draft,audience:"test-users"});
    expect((await store.get(x.tenant,x.admin,first,true)).organizationSkill).toMatchObject({activeRevisionId:draft,enabled:true,isPublished:false});
    expect((await store.listUpdates(x.tenant,x.author,20)).updates).toMatchObject([
      {kind:"released",audience:"test-users",organizationRevisionId:draft,skillName:"Team notes"},
      {kind:"accepted",organizationRevisionId:draft}]);
  });

  test("allows only linked source updates and hides later private admin drafts from authors", async () => {
    const x=await setup(), store=submissions();
    const first=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    await store.decide(x.tenant,x.admin,first,{version:1,action:"accept",reason:null,organizationSkillId:"team-notes",
      organizationSkillName:"Team notes",expectedOrganizationVersion:null});
    const current=await store.get(x.tenant,x.admin,first,true);
    await superuserPool().query(`UPDATE admin_skill_revisions SET metadata=jsonb_set(metadata,'{instructions}','"Admin private draft"'::jsonb)
      WHERE skill_revision_id=$1`,[current.latest.acceptedRevisionId]);
    const authorView=await store.get(x.tenant,x.author,first,false);
    expect(authorView.organizationSkill).toBeNull();
    expect(JSON.stringify(authorView)).not.toContain("Admin private draft");
    expect((await store.get(x.tenant,x.admin,first,true)).organizationSkill?.currentDraftContent?.instructions).toBe("Admin private draft");
    const update=await store.create(x.tenant,x.author,x.skill.id,1,"Update","team-notes");
    expect((await store.get(x.tenant,x.admin,update,true)).targetOrganizationSkillId).toBe("team-notes");
    const outsiderSkill=await personal().create(x.tenant,x.member,{...source,name:"other"});
    await expect(store.create(x.tenant,x.member,outsiderSkill.id,1,"", "team-notes")).rejects.toBeInstanceOf(SubmissionConflictError);
    await superuserPool().query("UPDATE tenant_memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[x.tenant,x.admin]);
    await expect(store.get(x.tenant,x.admin,first,true)).rejects.toBeInstanceOf(SubmissionAccessError);
    await expect(store.decide(x.tenant,x.admin,update,{version:1,action:"decline",reason:"No",organizationSkillId:null,
      organizationSkillName:null,expectedOrganizationVersion:null})).rejects.toBeInstanceOf(SubmissionAccessError);
  });

  test("accepts an update after an edited organization draft is released and rejects racing decisions", async () => {
    const x=await setup(), store=submissions();
    const first=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    const decisions=await Promise.allSettled(["first","second"].map(() => store.decide(x.tenant,x.admin,first,{
      version:1,action:"accept",reason:null,organizationSkillId:"team-notes",organizationSkillName:"Team notes",
      expectedOrganizationVersion:null})));
    expect(decisions.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(decisions.filter(result=>result.status==="rejected" && result.reason instanceof SubmissionConflictError)).toHaveLength(1);
    const accepted=await store.get(x.tenant,x.admin,first,true);
    const originalId=accepted.latest.acceptedRevisionId!;
    await superuserPool().query(`INSERT INTO admin_skill_revisions
      (tenant_id,skill_id,revision_number,source_type,bundle_name,bundle_hash,validation_status,review_status,metadata,created_by)
      VALUES ($1,'team-notes',2,'inline','team-notes',$2,'validated','pending_review',$3::jsonb,$4)`,
      [x.tenant,"a".repeat(64),JSON.stringify({skillName:"Team notes",description:"Edited",instructions:"Admin revised instructions"}),x.admin]);
    const edited=await store.get(x.tenant,x.admin,first,true);
    const editedId=edited.organizationSkill!.currentDraftRevisionId!;
    expect(editedId).not.toBe(originalId);
    await store.release(x.tenant,x.admin,first,{expectedOrganizationVersion:0,expectedActiveRevisionId:null,
      expectedDraftRevisionId:editedId,audience:"members"});
    await expect(store.release(x.tenant,x.admin,first,{expectedOrganizationVersion:1,expectedActiveRevisionId:editedId,
      expectedDraftRevisionId:editedId,audience:"test-users"})).rejects.toBeInstanceOf(SubmissionConflictError);
    const updated=await personal().update(x.tenant,x.author,x.skill.id,{...source,instructions:"New source version"},1);
    const next=await store.create(x.tenant,x.author,x.skill.id,updated.latest.revision,"Second update","team-notes");
    await store.decide(x.tenant,x.admin,next,{version:1,action:"accept",reason:null,organizationSkillId:"team-notes",
      organizationSkillName:"Team notes",expectedOrganizationVersion:1});
    const nextDetail=await store.get(x.tenant,x.admin,next,true);
    expect(nextDetail.organizationSkill).toMatchObject({activeRevisionId:editedId,enabled:true,isPublished:true});
    expect(nextDetail.latest.acceptedRevisionId).not.toBe(editedId);
  });

  test("serializes new-copy name decisions and keeps one open thread per source", async () => {
    const x=await setup(), store=submissions();
    const otherSkill=await personal().create(x.tenant,x.member,{...source,name:"other-notes"});
    const first=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    const second=await store.create(x.tenant,x.member,otherSkill.id,1,"",null);
    const results=await Promise.allSettled([
      store.decide(x.tenant,x.admin,first,{version:1,action:"accept",reason:null,
        organizationSkillId:"first-copy",organizationSkillName:"Shared name",expectedOrganizationVersion:null}),
      store.decide(x.tenant,x.admin,second,{version:1,action:"accept",reason:null,
        organizationSkillId:"second-copy",organizationSkillName:"Shared name",expectedOrganizationVersion:null})
    ]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected" && result.reason instanceof SubmissionConflictError)).toHaveLength(1);
    const open=results[0].status==="rejected" ? first : second;
    await store.decide(x.tenant,x.admin,open,{version:1,action:"request_changes",reason:"Add a step",
      organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null});
    const author=open===first ? x.author : x.member;
    const skillId=open===first ? x.skill.id : otherSkill.id;
    await expect(store.create(x.tenant,author,skillId,1,"New thread",null)).rejects.toBeInstanceOf(SubmissionConflictError);
    await store.withdraw(x.tenant,author,open,2);
    expect(await store.create(x.tenant,author,skillId,1,"New thread",null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("rolls back acceptance and organization revision when audit fails", async () => {
    const x=await setup(), store=submissions();
    const id=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
    const fail=vi.spyOn(AuditEventStore,"createInTransaction").mockRejectedValueOnce(new Error("audit failed"));
    try {
      await expect(store.decide(x.tenant,x.admin,id,{version:1,action:"accept",reason:null,
        organizationSkillId:"rollback-copy",organizationSkillName:"Rollback copy",
        expectedOrganizationVersion:null})).rejects.toThrow("audit failed");
    } finally { fail.mockRestore(); }
    expect(await store.get(x.tenant,x.admin,id,true)).toMatchObject({status:"pending",version:1});
    const org=await superuserPool().query("SELECT 1 FROM admin_skills WHERE tenant_id=$1 AND skill_id='rollback-copy'",[x.tenant]);
    expect(org.rowCount).toBe(0);
    const revisions=await superuserPool().query("SELECT 1 FROM admin_skill_revisions WHERE tenant_id=$1 AND skill_id='rollback-copy'",[x.tenant]);
    expect(revisions.rowCount).toBe(0);
  });

  // Every guard in release() refuses with its own reason and leaves the
  // organization skill unreleased. Each case changes one fact of an otherwise
  // releasable submission.
  describe("release refuses", () => {
    async function acceptedSubmission() {
      const x=await setup(), store=submissions();
      const id=await store.create(x.tenant,x.author,x.skill.id,1,"",null);
      await store.decide(x.tenant,x.admin,id,{version:1,action:"accept",reason:null,
        organizationSkillId:"team-notes",organizationSkillName:"Team notes",expectedOrganizationVersion:null});
      const draft=(await store.get(x.tenant,x.admin,id,true)).organizationSkill!.currentDraftRevisionId!;
      const input={expectedOrganizationVersion:0,expectedActiveRevisionId:null,expectedDraftRevisionId:draft,
        audience:"test-users" as const};
      return {x,store,id,draft,input};
    }
    /** The route maps only SubmissionConflictError to 409, so the class matters as much as the reason. */
    async function expectConflict(release: Promise<unknown>, message?: string) {
      const error=await release.then(()=>null,(caught: unknown)=>caught);
      expect(error).toBeInstanceOf(SubmissionConflictError);
      if (message) expect((error as Error).message).toBe(message);
    }
        async function expectUnreleased(x: { tenant: string }) {
      const org=await superuserPool().query("SELECT active_revision_id FROM admin_skills WHERE tenant_id=$1 AND skill_id='team-notes'",[x.tenant]);
      expect(org.rows[0].active_revision_id).toBeNull();
    }

    test("a member who is not a reviewer", async () => {
      const {x,store,id,input}=await acceptedSubmission();
      await expect(store.release(x.tenant,x.member,id,input)).rejects.toBeInstanceOf(SubmissionAccessError);
      await expectUnreleased(x);
    });

    test("an unknown submission", async () => {
      const {x,store,input}=await acceptedSubmission();
      await expect(store.release(x.tenant,x.admin,"00000000-0000-4000-8000-000000000000",input))
        .rejects.toBeInstanceOf(SubmissionNotFoundError);
    });

    test("a submission that was not accepted", async () => {
      const {x,store,input}=await acceptedSubmission();
      const pending=await store.create(x.tenant,x.author,x.skill.id,1,"Another",null);
      await expectConflict(store.release(x.tenant,x.admin,pending,input), "Accept the submission before release.");
      await expectUnreleased(x);
    });

    test("when another accepted submission owns a newer draft", async () => {
      const {x,store,id,input}=await acceptedSubmission();
      const other=await store.create(x.tenant,x.author,x.skill.id,1,"Another",null);
      const revisions=new SkillRevisionStore(appPool(),new SkillConfigStore(appPool()));
      const newer=await revisions.importSkillBundle(x.tenant,{skillId:"team-notes",skillName:"Team notes",
        description:"Newer",instructions:"Newer notes.",sourceType:"inline",sourceLabel:"newer",bundleName:"team-notes",
        bundleHash:"b".repeat(64),validationStatus:"validated",validationMessages:[],createdBy:x.admin,metadata:{},
        storeBundle:async()=>({storageUri:null})});
      await superuserPool().query(`UPDATE organization_skill_submissions SET status='accepted',accepted_skill_id='team-notes'
        WHERE tenant_id=$1 AND submission_id=$2`,[x.tenant,other]);
      await superuserPool().query(`UPDATE organization_skill_submission_attempts SET accepted_revision_id=$3
        WHERE tenant_id=$1 AND submission_id=$2`,[x.tenant,other,newer.revision.skillRevisionId]);
      await expectConflict(store.release(x.tenant,x.admin,id,input), "A newer accepted submission owns this organization draft.");
      await expectUnreleased(x);
    });

    test("when the skill changed after the impact preview", async () => {
      const {x,store,id,draft,input}=await acceptedSubmission();
      const stale={version:0,activeRevisionId:null,latestRevisionId:draft,enabled:false,isPublished:true};
      await expectConflict(store.release(x.tenant,x.admin,id,{...input,expectedSnapshot:stale}), "The skill changed after the preview. Refresh and review the impact again.");
      await expectUnreleased(x);
    });

    test.each([
      ["a draft no longer pending review", "review_status='approved'", "The current draft is no longer pending review."],
      ["a draft that failed validation", "validation_status='invalid'", "The current organization draft is not valid for release."],
      ["a draft without instructions", "metadata=metadata - 'instructions'", "The draft has incomplete content."]
    ])("%s", async (_case, change, message) => {
      const {x,store,id,draft,input}=await acceptedSubmission();
      await superuserPool().query(`UPDATE admin_skill_revisions SET ${change} WHERE skill_revision_id=$1`,[draft]);
      await expectConflict(store.release(x.tenant,x.admin,id,input), message);
      await expectUnreleased(x);
    });

    test("when the latest attempt has no accepted revision", async () => {
      const {x,store,id,input}=await acceptedSubmission();
      await superuserPool().query("UPDATE organization_skill_submissions SET latest_attempt=99 WHERE tenant_id=$1 AND submission_id=$2",[x.tenant,id]);
      // The other guards that use this default message pass for this valid input.
      await expectConflict(store.release(x.tenant,x.admin,id,input), "This submission or organization skill changed. Reload and try again.");
      await expectUnreleased(x);
    });
  });
});
