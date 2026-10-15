import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { registerOrganizationSkillSubmissionRoutes, type SubmissionStores } from "./organization-skill-submissions.js";
import { SubmissionAccessError, SubmissionConflictError, SubmissionNotFoundError,
  SubmissionValidationError } from "../services/skills/organization-skill-submission-store.js";

const apps: ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const scope={tenantId:"tenant",userId:"member"};
const id="00000000-0000-4000-8000-000000000001";
const personalSkillId="personal-skill-00000000-0000-4000-8000-000000000000";
const now="2026-01-01T00:00:00.000Z";
const attempt={attempt:1,status:"pending",note:"",snapshot:{content:{name:"notes",description:"Notes",instructions:"Write notes."},
  sourceRevision:1,contentHash:"a".repeat(64),validationMessages:[]},submittedAt:now,decidedAt:null,decidedBy:null,
  decidedByName:null,feedback:null,acceptedRevisionId:null};
const submission={id,version:1,status:"pending",authorUserId:"member",authorName:"Member",authorEmail:"member@example.test",
  sourceSkillId:personalSkillId,targetOrganizationSkillId:null,acceptedOrganizationSkillId:null,latest:attempt,
  createdAt:now,updatedAt:now};
const update={id:"00000000-0000-4000-8000-000000000002",submissionId:id,attempt:1,kind:"changes_requested",
  skillName:"notes",feedback:"Add a step",organizationSkillId:null,organizationRevisionId:null,audience:null,createdAt:now,readAt:null};
const detail={...submission,attempts:[attempt],updates:[update],organizationSkill:null};
async function setup(){
  const app=Fastify(); apps.push(app);
  app.addHook("preHandler",async request=>{request.auth={...scope,role:"member",isAdmin:false};});
  const organizationSkillSubmissions={
    list:vi.fn(async()=>[submission]),get:vi.fn(async()=>detail),create:vi.fn(async()=>id),
    withdraw:vi.fn(async()=>{}),resubmit:vi.fn(async()=>{}),decide:vi.fn(async()=>{}),release:vi.fn(async()=>{}),
    listUpdates:vi.fn(async()=>({updates:[update],unreadCount:1,nextCursor:null})),
    readUpdate:vi.fn(async()=>({id:update.id,readAt:now,unreadCount:0}))
  };
  await registerOrganizationSkillSubmissionRoutes(app,{organizationSkillSubmissions} as unknown as SubmissionStores);
  return {app,store:organizationSkillSubmissions};
}
test("routes submissions with authenticated scope and no cache",async()=>{
  const {app,store}=await setup();
  const created=await app.inject({method:"POST",url:"/me/skill-submissions",payload:{scope,personalSkillId,sourceRevision:1,note:""}});
  expect(created.statusCode).toBe(201); expect(created.headers["cache-control"]).toBe("private, no-store");
  expect(store.create).toHaveBeenCalledWith("tenant","member",personalSkillId,1,"",null);
  expect((await app.inject(`/me/skill-submissions/${id}`)).json().submission).toEqual(detail);
  await app.inject({method:"POST",url:`/me/skill-submissions/${id}/withdraw`,payload:{scope,version:1}});
  expect(store.withdraw).toHaveBeenCalledWith("tenant","member",id,1);
  await app.inject({method:"POST",url:`/me/skill-submissions/${id}/resubmit`,payload:{scope,version:2,sourceRevision:3,note:"Changed"}});
  expect(store.resubmit).toHaveBeenCalledWith("tenant","member",id,2,3,"Changed");
  await app.inject({method:"POST",url:`/admin/skill-submissions/${id}/decision`,payload:{scope,version:1,action:"decline",reason:"No"}});
  expect(store.decide).toHaveBeenCalledWith("tenant","member",id,expect.objectContaining({action:"decline",reason:"No"}));
  await app.inject({method:"POST",url:`/admin/skill-submissions/${id}/release`,payload:{scope,
    expectedOrganizationVersion:0,expectedActiveRevisionId:null,expectedDraftRevisionId:4,audience:"members"}});
  expect(store.release).toHaveBeenCalledWith("tenant","member",id,expect.objectContaining({expectedDraftRevisionId:4,audience:"members"}));
});
test("lists bounded author updates and marks only the addressed event",async()=>{
  const {app,store}=await setup();
  const listed=await app.inject("/me/skill-submission-updates?limit=10");
  expect(listed.statusCode).toBe(200);
  expect(listed.headers["cache-control"]).toBe("private, no-store");
  expect(listed.json()).toMatchObject({updates:[update],unreadCount:1});
  expect(store.listUpdates).toHaveBeenCalledWith("tenant","member",10,undefined);
  expect((await app.inject("/me/skill-submission-updates?limit=51")).statusCode).toBe(400);
  const read=await app.inject({method:"POST",url:`/me/skill-submission-updates/${update.id}/read`,payload:{scope}});
  expect(read.json()).toMatchObject({id:update.id,unreadCount:0});
  expect(store.readUpdate).toHaveBeenCalledWith("tenant","member",update.id);
  expect((await app.inject({method:"POST",url:`/me/skill-submission-updates/${update.id}/read`,
    payload:{scope:{tenantId:"other",userId:"member"}}})).statusCode).toBe(409);
});
test("rejects stale account scope before writes",async()=>{
  const {app,store}=await setup(); const wrong={tenantId:"other",userId:"member"};
  for(const request of [
    {url:"/me/skill-submissions",payload:{scope:wrong,personalSkillId,sourceRevision:1}},
    {url:`/me/skill-submissions/${id}/withdraw`,payload:{scope:wrong,version:1}},
    {url:`/admin/skill-submissions/${id}/decision`,payload:{scope:wrong,version:1,action:"accept"}},
    {url:`/admin/skill-submissions/${id}/release`,payload:{scope:wrong,expectedOrganizationVersion:0,
      expectedActiveRevisionId:null,expectedDraftRevisionId:1,audience:"members"}}
  ]) expect((await app.inject({method:"POST",...request})).statusCode).toBe(409);
  expect(store.create).not.toHaveBeenCalled();expect(store.withdraw).not.toHaveBeenCalled();
  expect(store.decide).not.toHaveBeenCalled();expect(store.release).not.toHaveBeenCalled();
});
test("maps current membership, hidden resource, conflict, and invalid decision",async()=>{
  const {app,store}=await setup();
  store.list.mockRejectedValueOnce(new SubmissionAccessError());
  expect((await app.inject("/admin/skill-submissions")).statusCode).toBe(403);
  store.get.mockRejectedValueOnce(new SubmissionNotFoundError());
  expect((await app.inject(`/me/skill-submissions/${id}`)).statusCode).toBe(404);
  store.withdraw.mockRejectedValueOnce(new SubmissionConflictError());
  expect((await app.inject({method:"POST",url:`/me/skill-submissions/${id}/withdraw`,payload:{scope,version:1}})).statusCode).toBe(409);
  store.decide.mockRejectedValueOnce(new SubmissionValidationError("Add reason"));
  expect((await app.inject({method:"POST",url:`/admin/skill-submissions/${id}/decision`,payload:{scope,version:1,action:"decline"}})).statusCode).toBe(400);
});
