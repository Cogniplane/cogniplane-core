import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import Fastify from "fastify";

import { GithubConnectionNotConfiguredError } from "../../services/integrations/github/github-connection-service.js";
import { registerAdminSkillRoutes } from "./admin-skill-routes.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import type { Pool } from "../../lib/db.js";
import type { SkillBundleStorage } from "../../services/skills/skill-bundle-storage.js";

const noopSkillBundleStorage: Pick<SkillBundleStorage, "materializeBundle"> = {
  async materializeBundle(storageUri: string) {
    return { localPath: storageUri.replace(/^file:\/\//, "") };
  }
};

// ---------------------------------------------------------------------------
// Minimal fake for the DynamicConfigService subset used by the skill routes
// ---------------------------------------------------------------------------

function makeSkillRecord(overrides: Partial<{
  skillId: string;
  githubToken?: string;
}> = {}) {
  const skillId = overrides.skillId ?? "test-skill";
  return {
    skillId,
    skillName: "Test Skill",
    description: null,
    instructions: "Do things.",
    version: 1,
    contentHash: "hash-test",
    enabled: false,
    isPublished: false,
    createdBy: "admin-user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRevisionId: null,
    activeSourceType: null,
    activeBundleName: null,
    activeBundleStorageUri: null,
    activeBundleHash: null,
    activeValidationStatus: null,
    activeReviewStatus: null
  };
}

function makeRevisionRecord(skillId: string) {
  return {
    skillRevisionId: 1,
    skillId,
    revisionNumber: 1,
    sourceType: "github",
    sourceLabel: "test/test-skill@main",
    bundleName: "test-skill",
    bundleStorageUri: "file:///tmp/test-skill",
    bundleHash: "hash-test",
    validationStatus: "validated",
    validationMessages: [],
    reviewStatus: "pending_review",
    reviewNotes: null,
    metadata: {
      skillName: "Test Skill",
      description: "desc",
      instructions: "Do things."
    },
    createdBy: "admin-user",
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    activatedAt: null
  };
}

type GithubImportInput = {
  githubUrl: string;
  ref?: string;
  subdirectory?: string;
  actorUserId: string;
  githubToken?: string;
};

function createFakeDynamicConfig(onGithubImport?: (input: GithubImportInput) => void) {
  return {
    async listSkills(_tenantId: string) {
      return [];
    },
    async disableSkill(_tenantId: string, _skillId: string) {
      return null;
    },
    async setSkillPublished(_tenantId: string, _skillId: string, _isPublished: boolean) {
      return null;
    },
    async importSkillBundleFromZip(_tenantId: string, _input: unknown) {
      return { skill: makeSkillRecord(), revision: makeRevisionRecord("test-skill"), previousActiveRevisionId: null };
    },
    async importSkillBundleFromGithub(_tenantId: string, input: GithubImportInput) {
      onGithubImport?.(input);
      return { skill: makeSkillRecord(), revision: makeRevisionRecord("test-skill"), previousActiveRevisionId: null };
    },
    async listSkillRevisions(_tenantId: string, _skillId: string) {
      return [];
    },
    async getSkillRevision(_tenantId: string, _skillId: string, _revisionId: number) {
      return null;
    },
    async activateSkillRevision(_tenantId: string, _input: unknown) {
      return null;
    },
    async cleanupInactiveSkillRevisions(_tenantId: string, _input: unknown) {
      return {
        dryRun: false,
        deletedRevisionIds: [],
        deletedBundleStorageUris: [],
        keptRevisionDecisions: [],
        failures: []
      };
    }
  };
}

function createFakeMarketplace() {
  return {
    async getCatalog() {
      return {
        status: "ready" as const,
        sourceUrl: "https://example.com",
        title: "Test",
        description: "desc",
        repositoryUrl: "https://example.com",
        fetchedAt: new Date().toISOString(),
        error: null,
        skills: []
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("GET /admin/skills/marketplace falls back to platform catalog when org manifest URL lookup fails", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

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

  let capturedCatalogOpts: unknown = "NOT_CALLED";
  const skillMarketplace = {
    async getCatalog(opts?: unknown) {
      capturedCatalogOpts = opts;
      return {
        status: "ready" as const,
        sourceUrl: "https://example.com",
        title: "Test",
        description: "desc",
        repositoryUrl: "https://example.com",
        fetchedAt: new Date().toISOString(),
        error: null,
        skills: []
      };
    }
  };

  await registerAdminSkillRoutes(app, {
    dynamicConfig: createFakeDynamicConfig(),
    skillMarketplace,
    auditEvents: new InMemoryAuditEventStore(),
    skillBundleStorage: noopSkillBundleStorage,
    tenantSettings: {
      async getMarketplaceManifestUrl(_tenantId: string): Promise<string | null> {
        throw new Error("DB connection error");
      }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/admin/skills/marketplace"
  });

  expect(response.statusCode).toBe(200);
  expect(capturedCatalogOpts).toBe(undefined);
});

test("github import route passes installation token to lifecycle service", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

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

  let capturedGithubToken: string | undefined = undefined;
  const dynamicConfig = createFakeDynamicConfig((input) => {
    capturedGithubToken = input.githubToken;
  });

  await registerAdminSkillRoutes(app, {
    dynamicConfig,
    skillMarketplace: createFakeMarketplace(),
    auditEvents: new InMemoryAuditEventStore(),
    skillBundleStorage: noopSkillBundleStorage,
    githubConnections: {
      async getRuntimeCredentials(_tenantId: string, _userId: string) {
        return {
          login: "octocat",
          name: "The Octocat",
          email: null,
          token: "ghtoken-abc123"
        };
      }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/admin/skills/import/github",
    payload: {
      githubUrl: "https://github.com/test-org/test-skill"
    }
  });

  expect(response.statusCode).toBe(201);
  expect(capturedGithubToken).toBe("ghtoken-abc123");
});

test("github import route proceeds without token when getRuntimeCredentials throws GithubConnectionNotConfiguredError", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

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

  let capturedGithubToken: string | undefined = "NOT_SET" as string | undefined;
  const dynamicConfig = createFakeDynamicConfig((input) => {
    capturedGithubToken = input.githubToken;
  });

  await registerAdminSkillRoutes(app, {
    dynamicConfig,
    skillMarketplace: createFakeMarketplace(),
    auditEvents: new InMemoryAuditEventStore(),
    skillBundleStorage: noopSkillBundleStorage,
    githubConnections: {
      async getRuntimeCredentials(_tenantId: string, _userId: string) {
        throw new GithubConnectionNotConfiguredError();
      }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/admin/skills/import/github",
    payload: {
      githubUrl: "https://github.com/test-org/test-skill"
    }
  });

  expect(response.statusCode).toBe(201);
  expect(capturedGithubToken).toBe(undefined);
});

// ---------------------------------------------------------------------------
// File preview route
// ---------------------------------------------------------------------------

async function buildAppWithRevisionFixture() {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-file-"));
  await mkdir(path.join(bundleRoot, "scripts"), { recursive: true });
  await writeFile(path.join(bundleRoot, "SKILL.md"), "---\nname: x\n---\nBody.\n");
  await writeFile(path.join(bundleRoot, "scripts", "hello.py"), "print('hello')\n");
  onTestFinished(() => rm(bundleRoot, { recursive: true, force: true }));

  const revision = {
    skillRevisionId: 42,
    skillId: "test-skill",
    revisionNumber: 1,
    sourceType: "zip",
    sourceLabel: null,
    bundleName: "test-skill",
    bundleStorageUri: `file://${bundleRoot}`,
    bundleHash: "hash",
    validationStatus: "validated",
    validationMessages: [] as Array<Record<string, unknown>>,
    reviewStatus: "pending_review",
    reviewNotes: null,
    metadata: {
      skillName: "Test",
      description: "d",
      instructions: "i",
      files: [
        { path: "SKILL.md", sizeBytes: 20 },
        { path: "scripts/hello.py", sizeBytes: 16 }
      ]
    } as Record<string, unknown>,
    createdBy: "admin-user",
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    activatedAt: null
  };

  const app = Fastify();
  onTestFinished(() => app.close());
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

  const dynamicConfig = createFakeDynamicConfig();
  (dynamicConfig as unknown as { getSkillRevision: typeof dynamicConfig.getSkillRevision }).getSkillRevision =
    async (_tenantId: string, skillId: string, revisionId: number) => {
      if (skillId === revision.skillId && revisionId === revision.skillRevisionId) {
        return revision;
      }
      return null;
    };

  await registerAdminSkillRoutes(app, {
    dynamicConfig,
    skillMarketplace: createFakeMarketplace(),
    auditEvents: new InMemoryAuditEventStore(),
    skillBundleStorage: noopSkillBundleStorage
  });
  await app.ready();

  return { app, revision, bundleRoot };
}

test("GET skill revision file returns file content for a manifest path", async () => {
  const { app } = await buildAppWithRevisionFixture();

  const response = await app.inject({
    method: "GET",
    url: "/admin/skills/test-skill/revisions/42/files?path=scripts/hello.py"
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    file: { path: string; encoding: string; content: string; contentType: string };
    limitBytes: number;
  };
  expect(body.file.path).toBe("scripts/hello.py");
  expect(body.file.encoding).toBe("utf8");
  expect(body.file.contentType).toBe("text/x-python");
  expect(body.file.content).toBe("print('hello')\n");
  expect(body.limitBytes).toBe(1_048_576);
});

test("GET skill revision file rejects paths outside the manifest", async () => {
  const { app } = await buildAppWithRevisionFixture();

  const response = await app.inject({
    method: "GET",
    url: "/admin/skills/test-skill/revisions/42/files?path=../etc/passwd"
  });

  expect(response.statusCode).toBe(404);
  const body = response.json() as { error: string };
  expect(body.error).toBe("skill_revision_file_not_found");
});

test("GET skill revision file returns 413 when file exceeds the limit", async () => {
  const { app, revision, bundleRoot } = await buildAppWithRevisionFixture();

  const largePath = path.join(bundleRoot, "big.txt");
  const big = Buffer.alloc(2_000_000, 0x41);
  await writeFile(largePath, big);
  (revision.metadata.files as Array<{ path: string; sizeBytes: number }>).push({
    path: "big.txt",
    sizeBytes: big.length
  });

  const response = await app.inject({
    method: "GET",
    url: "/admin/skills/test-skill/revisions/42/files?path=big.txt"
  });

  expect(response.statusCode).toBe(413);
  const body = response.json() as { error: string; sizeBytes: number; limitBytes: number };
  expect(body.error).toBe("skill_revision_file_too_large");
  expect(body.sizeBytes).toBe(big.length);
  expect(body.limitBytes).toBe(1_048_576);
});

test("admin skill routes reject non-admin callers with 403", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "member-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "member-user",
      tenantId: "tenant-1",
      isAdmin: false,
      role: "member" as const
    };
  });

  await registerAdminSkillRoutes(app, {
    dynamicConfig: createFakeDynamicConfig(),
    skillMarketplace: {
      async getCatalog() {
        throw new Error("catalog should not be consulted for non-admin callers");
      }
    },
    auditEvents: new InMemoryAuditEventStore(),
    skillBundleStorage: noopSkillBundleStorage,
    tenantSettings: {
      async getMarketplaceManifestUrl() {
        return null;
      }
    }
  });
  await app.ready();

  const marketplace = await app.inject({ method: "GET", url: "/admin/skills/marketplace" });
  expect(marketplace.statusCode).toBe(403);
  expect(marketplace.json()).toEqual({ error: "admin_required" });

  const revisionFile = await app.inject({
    method: "GET",
    url: "/admin/skills/test-skill/revisions/42/files?path=scripts/hello.py"
  });
  expect(revisionFile.statusCode).toBe(403);
  expect(revisionFile.json()).toEqual({ error: "admin_required" });
});
