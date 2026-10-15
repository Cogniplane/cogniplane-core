import { expect, test } from "vitest";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { OrganizationSkillSubmissionStore, SubmissionAccessError, SubmissionConflictError,
  SubmissionNotFoundError, SubmissionValidationError } from "./organization-skill-submission-store.js";

const tenant="tenant", author="author", admin="admin", id="00000000-0000-4000-8000-000000000001";
const sourceId="personal-skill-00000000-0000-4000-8000-000000000000";
const now=new Date("2026-01-01T00:00:00.000Z");
const row={tenant_id:tenant,submission_id:id,author_user_id:author,author_name:"Author",author_email:"author@example.test",
  source_skill_id:sourceId,target_skill_id:null,accepted_skill_id:null,version:1,status:"pending",latest_attempt:1,
  created_at:now,updated_at:now,attempt:1,attempt_status:"pending",note:"Please review",source_revision:1,
  source_name:"notes",source_description:"Notes",source_instructions:"Write notes.",content_hash:"a".repeat(64),
  validation_messages:[],submitted_at:now,decided_at:null,decided_by:null,decider_name:null,feedback:null,accepted_revision_id:null};
const result=(rows: Record<string,unknown>[])=>( {rows,rowCount:rows.length} );

test("list and detail require current membership, role, and author identity",async()=>{
  const denied=new FakePool().onQuery("FROM tenant_memberships",()=>result([]));
  await expect(new OrganizationSkillSubmissionStore(denied.asPool()).list(tenant,author,false)).rejects.toBeInstanceOf(SubmissionAccessError);
  const member=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"member"}]));
  await expect(new OrganizationSkillSubmissionStore(member.asPool()).list(tenant,author,true)).rejects.toBeInstanceOf(SubmissionAccessError);
  const pool=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"admin"}]))
    .onQuery("FROM organization_skill_submissions s",()=>result([row]))
    .onQuery("FROM organization_skill_submission_attempts a",()=>result([row]))
    .onQuery("FROM organization_skill_author_updates",()=>result([]));
  const store=new OrganizationSkillSubmissionStore(pool.asPool());
  const listed=await store.list(tenant,admin,true);
  expect(listed[0]).toMatchObject({authorName:"Author",latest:{snapshot:{content:{instructions:"Write notes."}}}});
  await expect(store.get(tenant,"other",id,false)).rejects.toBeInstanceOf(SubmissionNotFoundError);
  const detail=await store.get(tenant,admin,id,true);
  expect(detail.attempts).toHaveLength(1);
  expect(pool.queries.some(query=>query.text.includes("FOR SHARE"))).toBe(true);
});

test("create freezes a selected saved revision, records audit IDs, and rejects missing source",async()=>{
  const pool=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"member"}]))
    .onQuery("FROM personal_skill_revisions r",()=>result([{name:"notes",description:"Notes",instructions:"Write notes.",validation_messages:["Warning"]}]))
    .onQuery("INSERT INTO organization_skill_submissions",()=>result([]))
    .onQuery("INSERT INTO organization_skill_submission_attempts",()=>result([]))
    .onQuery("INSERT INTO audit_events",()=>result([]));
  const store=new OrganizationSkillSubmissionStore(pool.asPool());
  const created=await store.create(tenant,author,sourceId,1,"Review",null);
  expect(created).toMatch(/^[0-9a-f-]{36}$/);
  expect(pool.queries.find(query=>query.text.includes("INSERT INTO organization_skill_submission_attempts"))?.values)
    .toContain("Write notes.");
  expect(pool.queries.find(query=>query.text.includes("INSERT INTO audit_events"))?.values)
    .toContain("organization.skill_submission.created");
  const missing=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"member"}]))
    .onQuery("FROM personal_skill_revisions r",()=>result([]));
  await expect(new OrganizationSkillSubmissionStore(missing.asPool()).create(tenant,author,sourceId,1,"",null))
    .rejects.toBeInstanceOf(SubmissionNotFoundError);
});

test("withdraw checks author, version, and state before changing an attempt",async()=>{
  const pool=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"member"}]))
    .onQuery("FROM organization_skill_submissions WHERE",()=>result([row]))
    .onQuery("UPDATE organization_skill_submissions",()=>result([]))
    .onQuery("UPDATE organization_skill_submission_attempts",()=>result([]))
    .onQuery("INSERT INTO audit_events",()=>result([]));
  const store=new OrganizationSkillSubmissionStore(pool.asPool());
  await expect(store.withdraw(tenant,"other",id,1)).rejects.toBeInstanceOf(SubmissionNotFoundError);
  await expect(store.withdraw(tenant,author,id,2)).rejects.toBeInstanceOf(SubmissionConflictError);
  await store.withdraw(tenant,author,id,1);
  expect(pool.queries.some(query=>query.text.includes("status='withdrawn'"))).toBe(true);
});

test("decisions reject missing feedback and stale state under the reviewer lock",async()=>{
  const pool=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"admin"}]))
    .onQuery("FROM organization_skill_submissions WHERE",()=>result([row]));
  const store=new OrganizationSkillSubmissionStore(pool.asPool());
  await expect(store.decide(tenant,admin,id,{version:1,action:"decline",reason:null,
    organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null})).rejects.toBeInstanceOf(SubmissionValidationError);
  await expect(store.decide(tenant,admin,id,{version:2,action:"decline",reason:"No",
    organizationSkillId:null,organizationSkillName:null,expectedOrganizationVersion:null})).rejects.toBeInstanceOf(SubmissionConflictError);
  expect(pool.queries.some(query=>query.text.includes("INSERT INTO admin_skill_revisions"))).toBe(false);
});

test("release rejects a stale organization version before activation",async()=>{
  const pool=new FakePool().onQuery("FROM tenant_memberships",()=>result([{role:"admin"}]))
    .onQuery("SELECT accepted_skill_id,latest_attempt,status",()=>result([{accepted_skill_id:"team-notes",latest_attempt:1,status:"accepted"}]))
    .onQuery("SELECT s.submission_id FROM organization_skill_submissions s",()=>result([{submission_id:id}]))
    .onQuery("SELECT version,active_revision_id,enabled,is_published FROM admin_skills",()=>result([{version:2,active_revision_id:null,enabled:false,is_published:false}]));
  const store=new OrganizationSkillSubmissionStore(pool.asPool());
  await expect(store.release(tenant,admin,id,{expectedOrganizationVersion:1,expectedActiveRevisionId:null,
    expectedDraftRevisionId:4,audience:"members"})).rejects.toBeInstanceOf(SubmissionConflictError);
  expect(pool.queries.some(query=>query.text.includes("UPDATE admin_skills"))).toBe(false);
});
