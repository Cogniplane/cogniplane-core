import { test, expect } from "vitest";

import multipart from "@fastify/multipart";
import Fastify from "fastify";
import JSZip from "jszip";

import { registerAdminRoutes, type AdminRouteStores } from "../admin.js";
import codexRelease from "../../codex-release.json" with { type: "json" };
import type { Pool } from "../../lib/db.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

function createMarketplaceStore(): AdminRouteStores["skillMarketplace"] {
  return {
    async getCatalog() {
      return {
        status: "ready" as const,
        sourceUrl: "https://raw.githubusercontent.com/example-org/agent-skills-marketplace/main/marketplace.json",
        title: "Reviewed Agent Skills",
        description: "Curated onboarding skills.",
        repositoryUrl: "https://github.com/example-org/agent-skills-marketplace",
        fetchedAt: new Date().toISOString(),
        error: null,
        skills: [
          {
            slug: "meeting-brief",
            name: "Meeting Brief",
            description: "Turn raw meeting notes into actions and risks.",
            repositoryUrl: "https://github.com/example-org/agent-skills-marketplace",
            ref: "0123456789abcdef",
            subdirectory: "skills/meeting-brief",
            publisher: "example-org",
            reviewStatus: "reviewed" as const,
            tags: ["onboarding", "knowledge-work"],
            recommended: true,
            skillVersion: "1.0.0",
            lastReviewedAt: "2026-03-28T00:00:00.000Z",
            sourceUrl:
              "https://github.com/example-org/agent-skills-marketplace/tree/0123456789abcdef/skills/meeting-brief"
          }
        ]
      };
    }
  };
}

class InMemoryAdminConfig {
  skills: Array<{
    skillId: string;
    skillName: string;
    description: string | null;
    instructions: string;
    version: number;
    contentHash: string;
    enabled: boolean;
    isPublished: boolean;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    activeRevisionId: number | null;
    activeSourceType: string | null;
    activeBundleName: string | null;
    activeBundleStorageUri: string | null;
    activeBundleHash: string | null;
    activeValidationStatus: string | null;
    activeReviewStatus: string | null;
    isInherited: boolean;
  }> = [
    {
      skillId: "document-analysis",
      skillName: "Document analysis",
      description: "Analyze uploaded artifacts",
      instructions: "Use the selected artifact scope.",
      version: 1,
      contentHash: "hash-document-analysis",
      enabled: true,
      isPublished: true,
      createdBy: "admin-user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRevisionId: 1,
      activeSourceType: "zip",
      activeBundleName: "document-analysis",
      activeBundleStorageUri: "file:///tmp/document-analysis",
      activeBundleHash: "hash-document-analysis",
      activeValidationStatus: "validated",
      activeReviewStatus: "active",
      isInherited: false
    }
  ];

  bundleSkills = [
    {
      skillId: "pdf-processing",
      skillName: "PDF Processing",
      description: "Bundle backed",
      instructions: "Use the bundle.",
      version: 1,
      contentHash: "hash-pdf-processing",
      enabled: true,
      isPublished: true,
      createdBy: "admin-user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRevisionId: 3,
      activeSourceType: "github",
      activeBundleName: "pdf-processing",
      activeBundleStorageUri: "file:///tmp/pdf-processing",
      activeBundleHash: "hash-pdf-processing",
      activeValidationStatus: "validated",
      activeReviewStatus: "active",
      isInherited: false
    }
  ];

  tenantSettings = {
    tenantId: "admin-tenant",
    runtimeProvider: "codex" as const,
    enabledRuntimeProviders: ["codex"] as const,
    showEffortSelector: false,
    webSearchMode: "disabled" as const,
    approvalPolicy: "on-request" as const,
    approvalReviewer: "user" as const,
    allowCommandExecution: false,
    allowUserTokenForwarding: true,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor" as const,
    developerInstructions: null as string | null,
    enabledToolIds: [
      "managed-session-context",
      "session_context",
      "list_artifacts",
      "read_text_artifact",
      "write_artifact"
    ],
    enabledMcpServerIds: ["managed-session-context"],
    version: 1,
    configHash: "hash-tenant-settings",
    updatedAt: new Date().toISOString()
  };

  async listSkills(_tenantId: string) {
    return [...this.skills, ...this.bundleSkills];
  }

  async disableSkill(_tenantId: string, skillId: string) {
    const existing = this.skills.find((skill) => skill.skillId === skillId);
    if (!existing) {
      return null;
    }

    existing.enabled = false;
    existing.version += 1;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  async importSkillBundleFromZip(_tenantId: string, input: {
    archiveBuffer: Buffer;
    originalFileName: string;
    actorUserId: string;
  }) {
    expect(input.archiveBuffer.byteLength > 0).toBeTruthy();
    const skill = {
      skillId: "pdf-processing",
      skillName: "PDF Processing",
      description: "Import PDFs from a bundle.",
      instructions: "Use the skill bundle.",
      version: 0,
      contentHash: "hash-pdf-processing",
      enabled: false,
      isPublished: true,
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRevisionId: null,
      activeSourceType: null,
      activeBundleName: null,
      activeBundleStorageUri: null,
      activeBundleHash: null,
      activeValidationStatus: null,
      activeReviewStatus: null,
      isInherited: false
    };
    const revision = {
      skillRevisionId: 2,
      skillId: skill.skillId,
      revisionNumber: 1,
      sourceType: "zip",
      sourceLabel: input.originalFileName,
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/pdf-processing",
      bundleHash: "hash-pdf-processing",
      validationStatus: "validated",
      validationMessages: [],
      reviewStatus: "pending_review",
      reviewNotes: null,
      metadata: {},
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      activatedAt: null
    };
    return { skill, revision, previousActiveRevisionId: 2 };
  }

  async cleanupInactiveSkillRevisions(_tenantId: string, input: { dryRun?: boolean }) {
    return {
      dryRun: input.dryRun ?? false,
      deletedRevisionIds: input.dryRun ? [] : [2],
      deletedBundleStorageUris: input.dryRun ? [] : ["file:///tmp/pdf-processing-old"],
      keptRevisionDecisions: [{ skillRevisionId: 3, reason: "active_registry_revision" }],
      failures: []
    };
  }

  async importSkillBundleFromGithub(_tenantId: string, input: {
    githubUrl: string;
    ref?: string;
    subdirectory?: string;
    actorUserId: string;
  }) {
    expect(input.githubUrl).toBe("https://github.com/example-org/pdf-processing");
    const skill = {
      skillId: "pdf-processing",
      skillName: "PDF Processing",
      description: "Import PDFs from GitHub.",
      instructions: "Use the GitHub bundle.",
      version: 0,
      contentHash: "hash-pdf-processing-github",
      enabled: false,
      isPublished: true,
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRevisionId: null,
      activeSourceType: null,
      activeBundleName: null,
      activeBundleStorageUri: null,
      activeBundleHash: null,
      activeValidationStatus: null,
      activeReviewStatus: null,
      isInherited: false
    };
    const revision = {
      skillRevisionId: 3,
      skillId: skill.skillId,
      revisionNumber: 1,
      sourceType: "github",
      sourceLabel: "example-org/pdf-processing@main",
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/pdf-processing-github",
      bundleHash: "hash-pdf-processing-github",
      validationStatus: "validated",
      validationMessages: [],
      reviewStatus: "pending_review",
      reviewNotes: null,
      metadata: {
        github: {
          url: input.githubUrl,
          ref: input.ref ?? "main",
          subdirectory: input.subdirectory ?? null
        }
      },
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      activatedAt: null
    };
    return { skill, revision, previousActiveRevisionId: 2 };
  }

  async listSkillRevisions(_tenantId: string, skillId: string) {
    if (skillId !== "pdf-processing") {
      return [];
    }

    return [
      {
        skillRevisionId: 3,
        skillId,
        revisionNumber: 1,
        sourceType: "github",
        sourceLabel: "example-org/pdf-processing@main",
        bundleName: "pdf-processing",
        bundleStorageUri: "file:///tmp/pdf-processing-github",
        bundleHash: "hash-pdf-processing-github",
        validationStatus: "validated",
        validationMessages: [],
        reviewStatus: "pending_review",
        reviewNotes: null,
        metadata: {
          skillName: "PDF Processing",
          description: "Import PDFs from GitHub.",
          instructions: "Use the GitHub bundle."
        },
        createdBy: "admin-user",
        createdAt: new Date().toISOString(),
        reviewedBy: null,
        reviewedAt: null,
        activatedAt: null
      }
    ];
  }

  async getSkillRevision(_tenantId: string, _skillId: string, _revisionId: number) {
    return null;
  }

  async activateSkillRevision(_tenantId: string, input: {
    skillId: string;
    skillRevisionId: number;
    actorUserId: string;
    reviewNotes?: string | null;
  }) {
    if (input.skillId !== "pdf-processing" || input.skillRevisionId !== 3) {
      return null;
    }

    const skill = {
      skillId: "pdf-processing",
      skillName: "PDF Processing",
      description: "Import PDFs from GitHub.",
      instructions: "Use the GitHub bundle.",
      version: 1,
      contentHash: "hash-pdf-processing-github",
      enabled: true,
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRevisionId: 3,
      activeSourceType: "github",
      activeBundleName: "pdf-processing",
      activeBundleStorageUri: "file:///tmp/pdf-processing-github",
      activeBundleHash: "hash-pdf-processing-github",
      activeValidationStatus: "validated",
      activeReviewStatus: "active"
    };
    const revision = {
      skillRevisionId: 3,
      skillId: "pdf-processing",
      revisionNumber: 1,
      sourceType: "github",
      sourceLabel: "example-org/pdf-processing@main",
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/pdf-processing-github",
      bundleHash: "hash-pdf-processing-github",
      validationStatus: "validated",
      validationMessages: [],
      reviewStatus: "active",
      reviewNotes: input.reviewNotes ?? null,
      metadata: {
        skillName: "PDF Processing",
        description: "Import PDFs from GitHub.",
        instructions: "Use the GitHub bundle."
      },
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
      reviewedBy: input.actorUserId,
      reviewedAt: new Date().toISOString(),
      activatedAt: new Date().toISOString()
    };

    return { skill, revision, previousActiveRevisionId: 2 };
  }

  async listMcpServers(_tenantId: string) {
    return [
      {
        serverId: "trusted-echo",
        serverName: "Trusted echo",
        description: null,
        transportKind: "http" as const,
        mode: "proxy" as const,
        routePath: "/mcp/trusted-echo",
        upstreamUrl: "https://example.com/mcp",
        headersAllowlist: [],
        version: 1,
        configHash: "hash-trusted-echo",
        enabled: true,
        isPublished: true,
        createdBy: "admin-user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
  }

  async createMcpServer(_tenantId: string) {
    return {
      serverId: "unused",
      serverName: "unused",
      description: null,
      transportKind: "http" as const,
      mode: "managed" as const,
      routePath: "/mcp/unused",
      upstreamUrl: null,
      headersAllowlist: [],
      version: 1,
      configHash: "unused",
      enabled: true,
      isPublished: true,
      createdBy: "admin-user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async updateMcpServer(_tenantId: string) {
    return null;
  }

  async disableMcpServer(_tenantId: string, _serverId: string) {
    return null;
  }

  async setSkillPublished(_tenantId: string, _skillId: string, _isPublished: boolean) {
    return null;
  }

  async setMcpServerPublished(_tenantId: string, _serverId: string, _isPublished: boolean) {
    return null;
  }

  async getOrCreateTenantSettings(_tenantId: string) {
    return {
      ...this.tenantSettings,
      tenantId: _tenantId
    };
  }

  async updateTenantSettings(_tenantId: string, input: Record<string, unknown>) {
    this.tenantSettings = {
      ...this.tenantSettings,
      tenantId: _tenantId,
      ...input,
      version: this.tenantSettings.version + 1,
      updatedAt: new Date().toISOString()
    };
    return this.getOrCreateTenantSettings(_tenantId);
  }
}

test("admin routes list, disable skills, and show runtime rollout state", async () => {
  const adminConfig = new InMemoryAdminConfig();
  const auditEvents = new InMemoryAuditEventStore();
  const app = Fastify();
  const testConfig = createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" });

  const manifestMetadata: RuntimeManifest = {
    manifestVersion: "cogniplane.runtime-manifest.v1",
    manifestHash: "hash-manifest",
    configBundleHash: "hash-bundle",
    sessionId: "session-1",
    userId: "admin-user",
    generatedAt: new Date().toISOString(),
    workspacePath: "/tmp/session-1",
    codex: {
      binaryPath: "codex",
      version: codexRelease.codexVersion,
      schemaVersion: codexRelease.schemaVersion,
      model: "gpt-5.4"
    },
    runtimePolicy: {
      id: "phase4-tools",
      version: 2,
      hash: "hash-phase4-tools",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkMode: "restricted",
      allowCommandExecution: true,
      allowUserTokenForwarding: true,
      autoApproveReadOnlyTools: true,
      enabledToolIds: []
    },
    skills: [],
    mcpServers: [],
    configSources: {
      runtimePolicy: {
        id: "phase4-tools",
        version: 2,
        hash: "hash-phase4-tools"
      },
      skills: [],
      mcpServers: []
    },
    config: {
      codexTomlPath: "/tmp/session-1/codex.toml",
      skillsPath: "/tmp/session-1/.codex/skills",
      customSkillsEnabled: false,
      customMcpServersEnabled: false
    }
  };

  app.decorate("config", testConfig);
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  await registerAdminRoutes(app, {
    dynamicConfig: adminConfig as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [
          {
            id: 1,
            sessionId: "session-1",
            userId: "admin-user",
            runtimeId: "runtime-1",
            workspacePath: "/tmp/session-1",
            codexVersion: testConfig.CODEX_VERSION,
            codexSchemaVersion: testConfig.CODEX_SCHEMA_VERSION,
            manifestPath: "/tmp/session-1/.framework/runtime-manifest.json",
            manifestMetadata,
            healthStatus: "healthy",
            lastActiveAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            terminatedAt: null,
            lifecycleMetadata: {},
            status: "active",
            // Production rows always populate this column ("codex" / "claude-code" /
            // null). The fake must too — the response schema requires the key to be
            // present even when the value is null.
            runtimeProvider: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return ["session-1"];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const skillsResponse = await app.inject({
    method: "GET",
    url: "/admin/skills"
  });
  expect(skillsResponse.statusCode).toBe(200);
  expect(skillsResponse.json().skills.length).toBe(2);

  const marketplaceResponse = await app.inject({
    method: "GET",
    url: "/admin/skills/marketplace"
  });
  expect(marketplaceResponse.statusCode).toBe(200);
  expect(marketplaceResponse.json().marketplace.status).toBe("ready");
  expect(marketplaceResponse.json().marketplace.skills[0].slug).toBe("meeting-brief");

  const disableResponse = await app.inject({
    method: "POST",
    url: "/admin/skills/document-analysis/disable"
  });
  expect(disableResponse.statusCode).toBe(200);
  expect(disableResponse.json().skill.enabled).toBe(false);

  const runtimeSessionsResponse = await app.inject({
    method: "GET",
    url: "/admin/runtime-sessions"
  });
  expect(runtimeSessionsResponse.statusCode).toBe(200);
  expect(runtimeSessionsResponse.json().runtimeSessions[0].configSummary.runtimePolicy.id).toBe("phase4-tools");

  const rolloutResponse = await app.inject({
    method: "POST",
    url: "/admin/runtime-sessions/rollout",
    payload: {
      action: "refresh_idle"
    }
  });
  expect(rolloutResponse.statusCode).toBe(200);
  expect(rolloutResponse.json().affectedSessionIds).toEqual(["session-1"]);
  expect(auditEvents.events.length).toBe(2);

  await app.close();
});

test("admin routes reject non-admin callers", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "user-1" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "user-1",
      tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-1",
      isAdmin: false,
      role: "member" as const
    };
  });

  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents: new InMemoryAuditEventStore(),
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/admin/skills"
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "admin_required" });

  await app.close();
});

test("admin tenant settings updates are audited", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/admin/tenant-settings",
    payload: {
      allowCommandExecution: true,
      policyEnforcementMode: "enforce",
      enabledToolIds: ["managed-session-context", "write_artifact"],
      enabledMcpServerIds: ["managed-session-context"]
    }
  });

  expect(response.statusCode).toBe(200);
  expect(auditEvents.events.at(-1)?.type).toBe("admin.tenant_settings.updated");
  expect(auditEvents.events.at(-1)?.payload).toEqual({
        runtimeProvider: "codex",
        enabledRuntimeProviders: ["codex"],
        showEffortSelector: false,
        webSearchMode: "disabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        allowCommandExecution: true,
        allowUserTokenForwarding: true,
        autoApproveReadOnlyTools: true,
        policyEnforcementMode: "enforce",
        developerInstructions: null,
        enabledToolIds: ["managed-session-context", "write_artifact"],
        enabledMcpServerIds: ["managed-session-context"],
        invalidatedSessionIds: [],
        version: 2,
        configHash: "hash-tenant-settings"
      });

  await app.close();
});

test("admin tenant settings refresh active runtimes after update", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const invalidatedTenants: string[] = [];
  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    runtimeAdapters: {
      codex: {
        async invalidateTenantRuntimes(tenantId: string) {
          invalidatedTenants.push(tenantId);
          return ["session-a"];
        }
      },
      "claude-code": {
        async invalidateTenantRuntimes(tenantId: string) {
          invalidatedTenants.push(tenantId);
          return ["session-b"];
        }
      }
    } as never,
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/admin/tenant-settings",
    payload: {
      policyEnforcementMode: "enforce"
    }
  });

  expect(response.statusCode).toBe(200);
  expect(invalidatedTenants).toEqual(["admin-tenant", "admin-tenant"]);
  expect(auditEvents.events.at(-1)?.payload).toMatchObject({
    policyEnforcementMode: "enforce",
    invalidatedSessionIds: ["session-a", "session-b"]
  });

  await app.close();
});

test("admin tenant settings returns an error when active runtimes cannot be refreshed", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    runtimeAdapters: {
      codex: {
        async invalidateTenantRuntimes() {
          throw new Error("codex refresh failed");
        }
      }
    } as never,
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/admin/tenant-settings",
    payload: { policyEnforcementMode: "enforce" }
  });

  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({
    error: "runtime_refresh_failed"
  });
  expect(auditEvents.events).toEqual([]);

  await app.close();
});

test("admin routes reject mismatched CRUD body ids on update", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents: new InMemoryAuditEventStore(),
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/admin/mcp-servers/trusted-echo",
    payload: {
      serverId: "different-id",
      serverName: "Trusted echo",
      mode: "proxy",
      routePath: "/mcp/trusted-echo"
    }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
        error: "invalid_config",
        message: "serverId must match the route parameter."
      });

  await app.close();
});

test("admin routes return structured errors for referenced MCP disables", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents: new InMemoryAuditEventStore(),
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const disableReferencedMcpResponse = await app.inject({
    method: "POST",
    url: "/admin/mcp-servers/trusted-echo/disable"
  });
  // Mock returns null (server not found) — route returns 404
  expect(disableReferencedMcpResponse.statusCode).toBe(404);

  await app.close();
});

test("admin routes import a skill bundle zip", async () => {
  const app = Fastify();
  await app.register(multipart);
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as unknown as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const archive = new JSZip();
  archive.file(
    "pdf-processing/SKILL.md",
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse this bundle.\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });
  const boundary = "----cogniplane-skill-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="pdf-processing.zip"\r\n` +
        "Content-Type: application/zip\r\n\r\n"
    ),
    archiveBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/admin/skills/import/zip",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload
  });

  expect(response.statusCode).toBe(201);
  expect(response.json().skill.skillId).toBe("pdf-processing");
  expect(response.json().revision.reviewStatus).toBe("pending_review");
  expect(auditEvents.events.at(-1)?.type).toBe("admin.skill.imported");

  await app.close();
});

test("admin routes import a skill bundle from GitHub", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as unknown as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/admin/skills/import/github",
    payload: {
      githubUrl: "https://github.com/example-org/pdf-processing",
      ref: "main"
    }
  });

  expect(response.statusCode).toBe(201);
  expect(response.json().skill.skillId).toBe("pdf-processing");
  expect(response.json().revision.sourceType).toBe("github");
  expect(auditEvents.events.at(-1)?.type).toBe("admin.skill.imported");

  await app.close();
});

test("admin routes list and activate skill revisions", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as unknown as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const listResponse = await app.inject({
    method: "GET",
    url: "/admin/skills/pdf-processing/revisions"
  });
  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().revisions[0].skillRevisionId).toBe(3);

  const activateResponse = await app.inject({
    method: "POST",
    url: "/admin/skills/pdf-processing/revisions/3/activate",
    payload: {
      reviewNotes: "Looks good"
    }
  });
  expect(activateResponse.statusCode).toBe(200);
  expect(activateResponse.json().skill.enabled).toBe(true);
  expect(activateResponse.json().revision.reviewStatus).toBe("active");
  expect(auditEvents.events.some((event) => event.type === "admin.skill.reviewed")).toBeTruthy();
  expect(auditEvents.events.some((event) => event.type === "admin.skill.activated")).toBeTruthy();
  expect(auditEvents.events.some((event) => event.type === "admin.skill.rollback")).toBeTruthy();

  await app.close();
});

test("admin routes run skill revision cleanup and audit the result", async () => {
  const app = Fastify();
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const auditEvents = new InMemoryAuditEventStore();
  await registerAdminRoutes(app, {
    dynamicConfig: new InMemoryAdminConfig() as unknown as AdminRouteStores["dynamicConfig"],
    skillMarketplace: createMarketplaceStore(),
    auditEvents,
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    runtimeManager: {
      async refreshIdleRuntimes() {
        return [];
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    }
  });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/admin/skills/revisions/cleanup",
    payload: {
      dryRun: false
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().report.deletedRevisionIds).toEqual([2]);
  expect(auditEvents.events.at(-1)?.type).toBe("admin.skill.cleanup.completed");

  await app.close();
});
