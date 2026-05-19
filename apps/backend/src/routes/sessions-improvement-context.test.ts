import { test, expect, onTestFinished } from "vitest";

import Fastify from "fastify";

import { registerSessionRoutes } from "./sessions.js";
import { FakeDatabase } from "../test-helpers/fake-database.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import type { Pool } from "../lib/db.js";
import type { SessionRecord } from "../services/session-store.js";

type Stubs = Parameters<typeof registerSessionRoutes>[1];

function buildSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId: overrides.sessionId ?? "11111111-1111-4111-8111-111111111111",
    userId: overrides.userId ?? "admin-user",
    sessionName: overrides.sessionName ?? "Improve: example",
    status: overrides.status ?? "active",
    purpose: overrides.purpose ?? "skill_improvement",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now
  };
}

async function buildApp(stubs: Stubs) {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "tenant-1",
      isAdmin: true,
      role: "owner" as const
    };
  });
  await registerSessionRoutes(app, stubs);
  return app;
}

const noopExtras = {
  messages: { listBySession: async () => [] },
  runtimeManager: { abortSession: async () => undefined, hasSession: () => false },
  limits: { consumeRateLimit: async () => null }
} as const;

test("GET /sessions/:id/improvement-context returns skill metadata for improver sessions", async () => {
  const stored = buildSession();
  const app = await buildApp({
    ...noopExtras,
    sessions: {
      list: async () => [],
      create: async () => stored,
      rename: async () => stored,
      remove: async () => true,
      getOwned: async (_tenant, sessionId) =>
        sessionId === stored.sessionId ? stored : null
    },
    skillImprovementSessions: {
      get: async () => ({
        tenantId: "tenant-1",
        sessionId: stored.sessionId,
        skillId: "target-skill",
        corpusArtifactId: "artifact-corpus",
        sessionLimit: 50,
        model: null,
        effort: null,
        createdBy: "admin-user",
        createdAt: stored.createdAt
      })
    },
    skillConfig: {
      getSkill: async () => ({
        skillId: "target-skill",
        skillName: "Target Skill",
        description: null,
        instructions: "x",
        version: 1,
        contentHash: "h",
        enabled: true,
        isPublished: false,
        createdBy: "admin-user",
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        activeRevisionId: null,
        activeSourceType: null,
        activeBundleName: null,
        activeBundleStorageUri: null,
        activeBundleHash: null,
        activeValidationStatus: null,
        activeReviewStatus: null
      } as never)
    }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/sessions/${stored.sessionId}/improvement-context`
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        skillId: "target-skill",
        skillName: "Target Skill",
        corpusArtifactId: "artifact-corpus"
      });
});

test("GET /sessions/:id/improvement-context returns 404 for normal sessions", async () => {
  const stored = buildSession({ purpose: "normal" });
  const app = await buildApp({
    ...noopExtras,
    sessions: {
      list: async () => [],
      create: async () => stored,
      rename: async () => stored,
      remove: async () => true,
      getOwned: async () => stored
    }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/sessions/${stored.sessionId}/improvement-context`
  });

  expect(response.statusCode).toBe(404);
  const body = response.json() as { error?: string };
  expect(body.error).toBe("not_an_improvement_session");
});

test("GET /sessions/:id/improvement-context returns 404 when session is missing", async () => {
  const app = await buildApp({
    ...noopExtras,
    sessions: {
      list: async () => [],
      create: async () => buildSession(),
      rename: async () => buildSession(),
      remove: async () => true,
      getOwned: async () => null
    }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/sessions/22222222-2222-4222-8222-222222222222/improvement-context`
  });

  expect(response.statusCode).toBe(404);
});

test("GET /sessions/:id/improvement-context returns null skillName when skill row is gone", async () => {
  const stored = buildSession();
  const app = await buildApp({
    ...noopExtras,
    sessions: {
      list: async () => [],
      create: async () => stored,
      rename: async () => stored,
      remove: async () => true,
      getOwned: async () => stored
    },
    skillImprovementSessions: {
      get: async () => ({
        tenantId: "tenant-1",
        sessionId: stored.sessionId,
        skillId: "vanished-skill",
        corpusArtifactId: null,
        sessionLimit: 50,
        model: null,
        effort: null,
        createdBy: "admin-user",
        createdAt: stored.createdAt
      })
    },
    skillConfig: { getSkill: async () => null }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/sessions/${stored.sessionId}/improvement-context`
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        skillId: "vanished-skill",
        skillName: null,
        corpusArtifactId: null
      });
});
