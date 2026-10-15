// Skill-improvement corpus isolation against real Postgres (VULN-04).
//
// The corpus tool renders session ids, titles, timestamps and message content
// for every session it discovers. Discovery in skill-improvement-corpus.ts is
// scoped by tenant AND by the calling user, and message loading applies the
// session read-access check. The unit tests only see the SQL as text, so they
// cannot show that the two filters work together. This file seeds two users in
// one tenant and a third user in another tenant, all with sessions that used
// the SAME skill id, and checks what each caller gets back.
//
// It calls the production `gatherSkillCorpus` with the real `MessageStore`,
// like `activation-attribution.integration.test.ts`. Rows go in through the
// superuser pool, so a store bug cannot hide a missing row.

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, test } from "vitest";

import { MessageStore } from "../services/message-store.js";
import { gatherSkillCorpus } from "../services/skills/skill-improvement-corpus.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

type SeededSession = {
  sessionId: string;
  title: string;
  // The skill activation time, shown as "Last activity".
  activityAt: string;
  messageIds: string[];
  messageTimes: string[];
  texts: string[];
};

// Each session gets its own minute, so no timestamp is a substring of another
// and "this timestamp is absent" means something.
let minute = 0;
function nextTime(): Date {
  minute += 1;
  return new Date(Date.UTC(2026, 2, 1, 9, 0, 0) + minute * 60_000);
}

async function seedPerson(tenantId: string): Promise<string> {
  const userId = await seedUser();
  await seedMembership(tenantId, userId, "member");
  return userId;
}

async function seedProject(
  tenantId: string,
  ownerId: string,
  visibility: "private" | "organization"
): Promise<string> {
  const projectId = `project_${randomUUID()}`;
  await superuserPool().query(
    "INSERT INTO projects (project_id, tenant_id, user_id, name, visibility) VALUES ($1, $2, $3, 'Corpus project', $4)",
    [projectId, tenantId, ownerId, visibility]
  );
  await superuserPool().query(
    "INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
    [tenantId, projectId, ownerId]
  );
  return projectId;
}

async function seedSkillSession(input: {
  tenantId: string;
  userId: string;
  skillId: string;
  label: string;
  event?: "invoked" | "materialized";
  projectId?: string;
}): Promise<SeededSession> {
  const nonce = randomUUID().slice(0, 8);
  const sessionId = `session_${randomUUID()}`;
  const title = `${input.label} title ${nonce}`;
  const activity = nextTime();
  const userMessageId = `message_${randomUUID()}`;
  const assistantMessageId = `message_${randomUUID()}`;
  const userMessageTime = new Date(activity.getTime() + 1_000);
  const assistantMessageTime = new Date(activity.getTime() + 2_000);
  const texts = [
    `${input.label} prompt ${nonce}`,
    `${input.label} reply ${nonce}`,
    `${input.label} tool output ${nonce}`
  ];

  const db = superuserPool();
  await db.query(
    "INSERT INTO sessions (session_id, tenant_id, user_id, session_name, project_id) VALUES ($1, $2, $3, $4, $5)",
    [sessionId, input.tenantId, input.userId, title, input.projectId ?? null]
  );
  await db.query(
    `INSERT INTO messages (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'user', 'complete', $5, $6, $6),
            ($7, $2, $3, $4, 'assistant', 'complete', $8, $9, $9)`,
    [
      userMessageId, input.tenantId, sessionId, input.userId, texts[0], userMessageTime.toISOString(),
      assistantMessageId, texts[1], assistantMessageTime.toISOString()
    ]
  );
  await db.query(
    `INSERT INTO message_tool_results
       (tenant_id, message_id, session_id, user_id, tool_result_id, kind, title, status, input_text, output_text)
     VALUES ($1, $2, $3, $4, $5, 'command', 'run', 'completed', 'ls', $6)`,
    [input.tenantId, assistantMessageId, sessionId, input.userId, `tool_${randomUUID()}`, texts[2]]
  );
  await db.query(
    `INSERT INTO resource_activations (tenant_id, session_id, resource_type, resource_id, event_type, occurred_at)
     VALUES ($1, $2, 'skill', $3, $4, $5)`,
    [input.tenantId, sessionId, input.skillId, input.event ?? "invoked", activity.toISOString()]
  );

  return {
    sessionId,
    title,
    activityAt: activity.toISOString(),
    messageIds: [userMessageId, assistantMessageId],
    messageTimes: [userMessageTime.toISOString(), assistantMessageTime.toISOString()],
    texts
  };
}

const messages = () => new MessageStore(appPool());

function corpusFor(tenantId: string, userId: string, skillId: string) {
  return gatherSkillCorpus(
    {
      db: appPool(),
      async loadMessagesForSession(tenant, sessionId, user) {
        return (await messages().listBySession(tenant, sessionId, user)).messages;
      }
    },
    {
      tenantId,
      userId,
      skill: { skillId, skillName: "Shared skill", description: "Used by everyone", instructions: "Do the work." }
    }
  );
}

// Everything the corpus would print for a session.
function fragments(session: SeededSession): string[] {
  return [
    session.sessionId, session.title, session.activityAt,
    ...session.messageIds, ...session.messageTimes, ...session.texts
  ];
}

function expectVisible(markdown: string, session: SeededSession): void {
  for (const fragment of fragments(session)) expect(markdown).toContain(fragment);
}

function expectAbsent(markdown: string, session: SeededSession): void {
  for (const fragment of fragments(session)) expect(markdown).not.toContain(fragment);
}

describe.skipIf(!adminDatabaseUrl())("skill corpus isolation", () => {
  const skillId = `skill_${randomUUID()}`;
  let tenantA: string;
  let tenantB: string;
  let alice: string;
  let bob: string;
  let carol: string;
  let aliceInvoked: SeededSession;
  let aliceOffered: SeededSession;
  let bobPersonal: SeededSession;
  let bobPrivateProject: SeededSession;
  let bobSharedProject: SeededSession;
  let carolSession: SeededSession;

  beforeAll(async () => {
    tenantA = await seedTenant();
    tenantB = await seedTenant();
    alice = await seedPerson(tenantA);
    bob = await seedPerson(tenantA);
    carol = await seedPerson(tenantB);

    // Bob's private project has no other member. His shared project is visible
    // to the whole organization, so Alice can READ its sessions.
    const privateProject = await seedProject(tenantA, bob, "private");
    const sharedProject = await seedProject(tenantA, bob, "organization");

    aliceInvoked = await seedSkillSession({ tenantId: tenantA, userId: alice, skillId, label: "alice invoked" });
    aliceOffered = await seedSkillSession({
      tenantId: tenantA, userId: alice, skillId, label: "alice offered", event: "materialized"
    });
    bobPersonal = await seedSkillSession({ tenantId: tenantA, userId: bob, skillId, label: "bob personal" });
    bobPrivateProject = await seedSkillSession({
      tenantId: tenantA, userId: bob, skillId, label: "bob private project", projectId: privateProject
    });
    bobSharedProject = await seedSkillSession({
      tenantId: tenantA, userId: bob, skillId, label: "bob shared project", projectId: sharedProject
    });
    carolSession = await seedSkillSession({ tenantId: tenantB, userId: carol, skillId, label: "carol other tenant" });
  });

  test("a caller gets only their own sessions, titles, timestamps and content", async () => {
    const result = await corpusFor(tenantA, alice, skillId);

    expect(result.sessionsConsidered.sort()).toEqual([aliceInvoked.sessionId, aliceOffered.sessionId].sort());
    expect(result.includedSessionCount).toBe(2);
    expectVisible(result.markdown, aliceInvoked);
    expectVisible(result.markdown, aliceOffered);
    for (const other of [bobPersonal, bobPrivateProject, bobSharedProject, carolSession]) {
      expectAbsent(result.markdown, other);
    }
    expect(result.markdown).not.toContain(bob);
    expect(result.markdown).not.toContain(carol);
    expect(result.markdown).not.toContain(tenantB);
  });

  test("a second user in the same tenant gets their own sessions, including private-project ones", async () => {
    const result = await corpusFor(tenantA, bob, skillId);

    expect(result.sessionsConsidered.sort()).toEqual(
      [bobPersonal.sessionId, bobPrivateProject.sessionId, bobSharedProject.sessionId].sort()
    );
    expect(result.includedSessionCount).toBe(3);
    for (const own of [bobPersonal, bobPrivateProject, bobSharedProject]) {
      expectVisible(result.markdown, own);
    }
    for (const other of [aliceInvoked, aliceOffered, carolSession]) {
      expectAbsent(result.markdown, other);
    }
    expect(result.markdown).not.toContain(alice);
  });

  test("a user in another tenant sees only their own session, though the skill id is shared", async () => {
    const result = await corpusFor(tenantB, carol, skillId);

    expect(result.sessionsConsidered).toEqual([carolSession.sessionId]);
    expect(result.includedSessionCount).toBe(1);
    expectVisible(result.markdown, carolSession);
    for (const other of [aliceInvoked, aliceOffered, bobPersonal, bobPrivateProject, bobSharedProject]) {
      expectAbsent(result.markdown, other);
    }
    expect(result.markdown).not.toContain(tenantA);
  });

  test("a shared-project session that the caller can read still stays out of their corpus", async () => {
    // The read gate alone would let Alice open Bob's shared-project session.
    // Only the user filter in corpus discovery keeps it out of her corpus.
    const readable = await messages().listBySession(tenantA, bobSharedProject.sessionId, alice);
    expect(readable.messages.map((message) => message.messageId)).toEqual(bobSharedProject.messageIds);

    const result = await corpusFor(tenantA, alice, skillId);

    expect(result.sessionsConsidered).not.toContain(bobSharedProject.sessionId);
    expectAbsent(result.markdown, bobSharedProject);
  });

  test("a private session the caller cannot read gives them no content, even by direct read", async () => {
    for (const hidden of [bobPersonal, bobPrivateProject]) {
      const direct = await messages().listBySession(tenantA, hidden.sessionId, alice);
      expect(direct.messages).toEqual([]);
    }
  });

  test("a caller outside the tenant gets an empty corpus for another tenant's skill sessions", async () => {
    for (const [tenantId, userId] of [[tenantB, alice], [tenantA, carol]] as const) {
      const result = await corpusFor(tenantId, userId, skillId);

      expect(result.sessionsConsidered).toEqual([]);
      expect(result.includedSessionCount).toBe(0);
      for (const session of [aliceInvoked, aliceOffered, bobPersonal, bobPrivateProject, bobSharedProject, carolSession]) {
        expectAbsent(result.markdown, session);
      }
    }
  });

  test("a session leaves the caller's corpus when their project access is revoked", async () => {
    const tenantId = await seedTenant();
    const owner = await seedPerson(tenantId);
    const member = await seedPerson(tenantId);
    const revokedSkillId = `skill_${randomUUID()}`;
    const projectId = await seedProject(tenantId, owner, "private");
    await superuserPool().query(
      "INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'editor')",
      [tenantId, projectId, member]
    );
    const projectSession = await seedSkillSession({
      tenantId, userId: member, skillId: revokedSkillId, label: "member project session", projectId
    });
    const personalSession = await seedSkillSession({
      tenantId, userId: member, skillId: revokedSkillId, label: "member personal session"
    });

    const before = await corpusFor(tenantId, member, revokedSkillId);
    expect(before.includedSessionCount).toBe(2);
    expectVisible(before.markdown, projectSession);
    expectVisible(before.markdown, personalSession);

    // The member keeps the session row, but loses the project that gave read access.
    await superuserPool().query(
      "DELETE FROM project_memberships WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3",
      [tenantId, projectId, member]
    );
    const after = await corpusFor(tenantId, member, revokedSkillId);

    expect(after.includedSessionCount).toBe(1);
    expectAbsent(after.markdown, projectSession);
    expectVisible(after.markdown, personalSession);
  });
});
