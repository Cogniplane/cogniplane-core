import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import JSZip from "jszip";

import { createTestConfig } from "../test-helpers/test-config.js";

import {
  type ImportedSkillBundleRecord
} from "./admin-config-records.js";
import { DynamicConfigService, parseGitHubSkillSource } from "./dynamic-config-service.js";
import { ManagedToolCatalog } from "./managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "./managed-tools/factory.js";
import { registerBuiltinManagedTools } from "./managed-tools/register-builtin-managed-tools.js";
import { LocalSkillBundleStorage, type SkillBundleStorage } from "./skills/skill-bundle-storage.js";

function makeManagedToolCatalog(): ManagedToolCatalog {
  const catalog = new ManagedToolCatalog();
  registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
  return catalog;
}

type CapturedImport = {
  skillId: string;
  sourceType: string;
  bundleStorageUri: string;
};

test("parseGitHubSkillSource supports tree URLs and validates subdirectories", () => {
  const parsed = parseGitHubSkillSource({
    githubUrl: "https://github.com/example-org/skills/tree/main/pdf-processing",
    subdirectory: "pdf-processing"
  });

  expect(parsed.owner).toBe("example-org");
  expect(parsed.repo).toBe("skills");
  expect(parsed.ref).toBe("main");
  expect(parsed.subdirectory).toBe("pdf-processing");

  expect(() =>
          parseGitHubSkillSource({
            githubUrl: "https://github.com/example-org/skills",
            subdirectory: "../escape"
          })).toThrow(/subdirectory/);

  expect(() =>
          parseGitHubSkillSource({
            githubUrl: "https://github.com/example-org/skills/blob/main/SKILL.md"
          })).toThrow(/repository root or tree path/);

  expect(() =>
          parseGitHubSkillSource({
            githubUrl: "https://github.com/example-org/skills/tree"
          })).toThrow(/include a ref/);
});

test("DynamicConfigService imports a public GitHub skill bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-github-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const storage = new LocalSkillBundleStorage(path.join(root, "cache"));
  const archive = new JSZip();
  archive.file(
    "example-org-skills-main/skills/pdf-processing/SKILL.md",
    "---\nname: pdf-processing\ndescription: Process PDFs from GitHub\n---\nUse the bundle.\n"
  );
  // Multi-file bundle (companion script) so the import is NOT auto-promoted to
  // inline storage — this test verifies bundle persistence.
  archive.file(
    "example-org-skills-main/skills/pdf-processing/scripts/extract.py",
    "print('extract')\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const capturedImports: CapturedImport[] = [];
  const service = new DynamicConfigService(
    createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    {
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() { return []; },
        async listActiveRuntimeSkillReferences(_tenantId: string) { return []; },
        async deleteSkillRevision() { return null; },
        async countSkillRevisionsByBundleStorageUri() { return 0; },
        async importSkillBundle(_tenantId: string, input: {
          skillId: string;
          skillName: string;
          description: string;
          instructions: string;
          sourceType: string;
          sourceLabel: string;
          bundleName: string;
          bundleHash: string;
          validationStatus: string;
          validationMessages: Array<Record<string, unknown>>;
          metadata: Record<string, unknown>;
          createdBy: string;
          storeBundle: (input: { revisionNumber: number }) => Promise<{ storageUri: string | null }>;
        }) {
          const { storageUri } = await input.storeBundle({ revisionNumber: 1 });
          capturedImports.push({
            skillId: input.skillId,
            sourceType: input.sourceType,
            bundleStorageUri: storageUri
          });
          return {
            skill: {
              skillId: input.skillId,
              skillName: input.skillName,
              description: input.description,
              instructions: input.instructions,
              version: 0,
              contentHash: input.bundleHash,
              enabled: false,
              createdBy: input.createdBy,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              activeRevisionId: null,
              activeSourceType: null,
              activeBundleName: null,
              activeBundleStorageUri: null,
              activeBundleHash: null,
              activeValidationStatus: null,
              activeReviewStatus: null
            },
            revision: {
              skillRevisionId: 1,
              skillId: input.skillId,
              revisionNumber: 1,
              sourceType: input.sourceType,
              sourceLabel: input.sourceLabel,
              bundleName: input.bundleName,
              bundleStorageUri: storageUri,
              bundleHash: input.bundleHash,
              validationStatus: input.validationStatus,
              validationMessages: [],
              reviewStatus: "pending_review",
              reviewNotes: null,
              metadata: input.metadata,
              createdBy: input.createdBy,
              createdAt: new Date().toISOString(),
              reviewedBy: null,
              reviewedAt: null,
              activatedAt: null
            }
          } as ImportedSkillBundleRecord;
        }
      },
      skills: {} as never,
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    storage,
    makeManagedToolCatalog(),
    (async (url: string | URL) => {
      const value = url.toString();
      if (value.includes("/repos/example-org/skills") && !value.includes("zipball")) {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (value.includes("/zipball/main")) {
        return new Response(new Uint8Array(archiveBuffer), {
          status: 200,
          headers: { "Content-Type": "application/zip" }
        });
      }

      throw new Error(`Unexpected fetch URL: ${value}`);
    }) as typeof fetch
  );

  const imported = await service.importSkillBundleFromGithub("test-tenant", {
    githubUrl: "https://github.com/example-org/skills",
    subdirectory: "skills/pdf-processing",
    actorUserId: "admin-user"
  });

  expect(imported.skill.skillId).toBe("pdf-processing");
  expect(imported.revision.sourceType).toBe("github");
  expect(capturedImports.length).toBe(1);
  expect(capturedImports[0]?.skillId).toBe("pdf-processing");
  expect(capturedImports[0]?.sourceType).toBe("github");
  expect(typeof capturedImports[0]?.bundleStorageUri).toBe("string");
});

test("DynamicConfigService rejects oversized zip uploads before extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-zip-limit-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const service = new DynamicConfigService(
    createTestConfig({
      SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache"),
      ARTIFACT_MAX_UPLOAD_BYTES: 8
    }),
    {
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() { return []; },
        async listActiveRuntimeSkillReferences(_tenantId: string) { return []; },
        async deleteSkillRevision() { return null; },
        async countSkillRevisionsByBundleStorageUri() { return 0; },
        async importSkillBundle() {
          throw new Error("importSkillBundle should not be called");
        }
      },
      skills: {} as never,
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    new LocalSkillBundleStorage(path.join(root, "cache")),
    makeManagedToolCatalog()
  );

  await expect(service.importSkillBundleFromZip("test-tenant", {
        archiveBuffer: Buffer.alloc(9),
        originalFileName: "too-large.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/maximum allowed size/);
});

test("DynamicConfigService imports zip bundles from nested archive wrappers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-zip-wrapper-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "__MACOSX/._ignored",
    "ignored"
  );
  archive.file(
    "downloads/export/pdf-processing/SKILL.md",
    "---\nname: pdf-processing\ndescription: Wrapped zip import\n---\nUse the bundle.\n"
  );
  // Multi-file bundle so the import is NOT auto-promoted to inline storage —
  // this test verifies bundle persistence under nested archive wrappers.
  archive.file(
    "downloads/export/pdf-processing/scripts/extract.py",
    "print('extract')\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const capturedImports: CapturedImport[] = [];
  const service = new DynamicConfigService(
    createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    {
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() { return []; },
        async listActiveRuntimeSkillReferences(_tenantId: string) { return []; },
        async deleteSkillRevision() { return null; },
        async countSkillRevisionsByBundleStorageUri() { return 0; },
        async importSkillBundle(_tenantId: string, input: {
          skillId: string;
          skillName: string;
          description: string;
          instructions: string;
          sourceType: string;
          sourceLabel: string;
          bundleName: string;
          bundleHash: string;
          validationStatus: string;
          validationMessages: Array<Record<string, unknown>>;
          metadata: Record<string, unknown>;
          createdBy: string;
          storeBundle: (input: { revisionNumber: number }) => Promise<{ storageUri: string | null }>;
        }) {
          const { storageUri } = await input.storeBundle({ revisionNumber: 1 });
          capturedImports.push({
            skillId: input.skillId,
            sourceType: input.sourceType,
            bundleStorageUri: storageUri
          });

          return {
            skill: {
              skillId: input.skillId,
              skillName: input.skillName,
              description: input.description,
              instructions: input.instructions,
              version: 0,
              contentHash: input.bundleHash,
              enabled: false,
              createdBy: input.createdBy,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              activeRevisionId: null,
              activeSourceType: null,
              activeBundleName: null,
              activeBundleStorageUri: null,
              activeBundleHash: null,
              activeValidationStatus: null,
              activeReviewStatus: null
            },
            revision: {
              skillRevisionId: 1,
              skillId: input.skillId,
              revisionNumber: 1,
              sourceType: input.sourceType,
              sourceLabel: input.sourceLabel,
              bundleName: input.bundleName,
              bundleStorageUri: storageUri,
              bundleHash: input.bundleHash,
              validationStatus: input.validationStatus,
              validationMessages: [],
              reviewStatus: "pending_review",
              reviewNotes: null,
              metadata: input.metadata,
              createdBy: input.createdBy,
              createdAt: new Date().toISOString(),
              reviewedBy: null,
              reviewedAt: null,
              activatedAt: null
            }
          } as ImportedSkillBundleRecord;
        }
      },
      skills: {} as never,
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    new LocalSkillBundleStorage(path.join(root, "cache")),
    makeManagedToolCatalog()
  );

  const imported = await service.importSkillBundleFromZip("test-tenant", {
    archiveBuffer,
    originalFileName: "wrapped.zip",
    actorUserId: "admin-user"
  });

  expect(imported.skill.skillId).toBe("pdf-processing");
  expect(capturedImports.length).toBe(1);
  // Bundle paths are now tenant-scoped: <root>/cache/<tenantId>/<bundleName>/...
  expect(capturedImports[0]!.bundleStorageUri).toMatch(/^file:\/\/.*\/cache\/[^/]+\/pdf-processing\//);
});

test("DynamicConfigService rejects inline edits of inherited (system) skills from a tenant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-inherited-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const service = new DynamicConfigService(
    createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    {
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() { return []; },
        async listActiveRuntimeSkillReferences(_tenantId: string) { return []; },
        async deleteSkillRevision() { return null; },
        async countSkillRevisionsByBundleStorageUri() { return 0; },
        async importSkillBundle() {
          throw new Error("importSkillBundle should not be called for inherited skills");
        }
      },
      skills: {
        async getSkillOwnerTenantId(_tenantId: string, _skillId: string) {
          return "system";
        }
      } as never,
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    new LocalSkillBundleStorage(path.join(root, "cache")),
    makeManagedToolCatalog()
  );

  await expect(service.importSkillBundleFromInline("acme-tenant", {
        skillId: "write-artifact",
        skillName: "Write Artifact",
        description: "Inherited skill",
        instructions: "# Updated\n",
        actorUserId: "admin-user"
      })).rejects.toThrow(/system-provided skill and cannot be edited/);
});

test("DynamicConfigService allows inline edits when the tenant owns the skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-tenant-edit-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  let importCalled = false;
  const service = new DynamicConfigService(
    createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    {
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() { return []; },
        async listActiveRuntimeSkillReferences(_tenantId: string) { return []; },
        async deleteSkillRevision() { return null; },
        async countSkillRevisionsByBundleStorageUri() { return 0; },
        async importSkillBundle(_tenantId: string, input: { skillId: string; storeBundle: (i: { revisionNumber: number }) => Promise<{ storageUri: string | null }> }) {
          importCalled = true;
          await input.storeBundle({ revisionNumber: 2 });
          return {
            skill: { skillId: input.skillId } as never,
            revision: { skillRevisionId: 2, sourceType: "inline" } as never
          } as ImportedSkillBundleRecord;
        }
      },
      skills: {
        async getSkillOwnerTenantId(tenantId: string, _skillId: string) {
          return tenantId;
        }
      } as never,
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    new LocalSkillBundleStorage(path.join(root, "cache")),
    makeManagedToolCatalog()
  );

  await service.importSkillBundleFromInline("acme-tenant", {
    skillId: "tenant-owned-skill",
    skillName: "Tenant Owned",
    description: "Tenant-owned skill",
    instructions: "# Body\n",
    actorUserId: "admin-user"
  });

  expect(importCalled).toBe(true);
});

test("DynamicConfigService cleans up inactive skill revisions after the retention window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-dynamic-config-cleanup-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const deletedRevisions: number[] = [];
  const deletedBundles: string[] = [];
  const service = new DynamicConfigService(
    createTestConfig({
      SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache"),
      SKILL_BUNDLE_RETENTION_DAYS: 30
    }),
    {
      skills: {
        async listSkills() {
          return [
            {
              skillId: "pdf-processing",
              skillName: "PDF Processing",
              description: "Bundle",
              instructions: "Use the bundle.",
              version: 2,
              contentHash: "hash-active",
              enabled: true,
              isPublished: true,
              createdBy: "admin-user",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              activeRevisionId: 2,
              activeSourceType: "github",
              activeBundleName: "pdf-processing",
              activeBundleStorageUri: `file://${path.join(root, "cache", "pdf-processing", "hash-active")}`,
              activeBundleHash: "hash-active",
              activeValidationStatus: "validated",
              activeReviewStatus: "active"
            }
          ];
        },
        async getSkill() { return null; },
        async disableSkill() { return null; },
        async setSkillPublished() { return null; }
      },
      skillRevisions: {
        async listSkillRevisions() { return []; },
        async getSkillRevision() { return null; },
        async activateSkillRevision() { return null; },
        async listAllSkillRevisions() {
          return [
            {
              skillRevisionId: 2,
              skillId: "pdf-processing",
              revisionNumber: 2,
              sourceType: "github",
              sourceLabel: "repo@main",
              bundleName: "pdf-processing",
              bundleStorageUri: `file://${path.join(root, "cache", "pdf-processing", "hash-active")}`,
              bundleHash: "hash-active",
              validationStatus: "validated",
              validationMessages: [],
              reviewStatus: "active",
              reviewNotes: null,
              metadata: {},
              createdBy: "admin-user",
              createdAt: new Date().toISOString(),
              reviewedBy: "admin-user",
              reviewedAt: new Date().toISOString(),
              activatedAt: new Date().toISOString()
            },
            {
              skillRevisionId: 1,
              skillId: "pdf-processing",
              revisionNumber: 1,
              sourceType: "github",
              sourceLabel: "repo@old",
              bundleName: "pdf-processing",
              bundleStorageUri: `file://${path.join(root, "cache", "pdf-processing", "hash-old")}`,
              bundleHash: "hash-old",
              validationStatus: "validated",
              validationMessages: [],
              reviewStatus: "approved",
              reviewNotes: null,
              metadata: {},
              createdBy: "admin-user",
              createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
              reviewedBy: "admin-user",
              reviewedAt: new Date().toISOString(),
              activatedAt: new Date().toISOString()
            }
          ];
        },
        async listActiveRuntimeSkillReferences(_tenantId: string) {
          return [];
        },
        async deleteSkillRevision(_tenantId: string, skillId: string, skillRevisionId: number) {
          deletedRevisions.push(skillRevisionId);
          return {
            skillRevisionId,
            skillId,
            revisionNumber: 1,
            sourceType: "github",
            sourceLabel: "repo@old",
            bundleName: "pdf-processing",
            bundleStorageUri: `file://${path.join(root, "cache", "pdf-processing", "hash-old")}`,
            bundleHash: "hash-old",
            validationStatus: "validated",
            validationMessages: [],
            reviewStatus: "approved",
            reviewNotes: null,
            metadata: {},
            createdBy: "admin-user",
            createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
            reviewedBy: "admin-user",
            reviewedAt: new Date().toISOString(),
            activatedAt: new Date().toISOString()
          };
        },
        async countSkillRevisionsByBundleStorageUri() {
          return 0;
        },
        async importSkillBundle() {
          throw new Error("importSkillBundle should not be called");
        }
      },
      mcpServers: {} as never,
      tenantSettings: { async get() { return null; }, async upsert() { return {} as never; } }
    },
    {
      async storeBundle() {
        throw new Error("storeBundle should not be called");
      },
      async deleteBundle(bundlePath: string) {
        deletedBundles.push(bundlePath);
      }
    } as unknown as SkillBundleStorage,
    makeManagedToolCatalog()
  );

  const report = await service.cleanupInactiveSkillRevisions("test-tenant", {});

  expect(deletedRevisions).toEqual([1]);
  expect(deletedBundles).toEqual([`file://${path.join(root, "cache", "pdf-processing", "hash-old")}`]);
  expect(report.deletedRevisionIds).toEqual([1]);
  expect(report.keptRevisionDecisions.some((decision) => decision.skillRevisionId === 2)).toBeTruthy();
});

test("DynamicConfigService blocks disabling default MCP servers before tenant settings exist", async () => {
  let disableCalls = 0;
  const service = new DynamicConfigService(
    createTestConfig(),
    {
      skills: {} as never,
      skillRevisions: {} as never,
      mcpServers: {
        async disableMcpServer() {
          disableCalls += 1;
          return null;
        }
      } as never,
      tenantSettings: {
        async get() {
          return null;
        },
        async upsert() {
          throw new Error("upsert should not be called");
        }
      }
    },
    {} as SkillBundleStorage,
    makeManagedToolCatalog()
  );

  await expect(() => service.disableMcpServer("tenant-1", "managed-session-context")).rejects.toThrow(/referenced by the tenant's active settings/);
  expect(disableCalls).toBe(0);
});

test("DynamicConfigService rejects unknown tenant tool IDs before persisting settings", async () => {
  let upsertCalls = 0;
  const service = new DynamicConfigService(
    createTestConfig(),
    {
      skills: {} as never,
      skillRevisions: {} as never,
      mcpServers: {
        async listMcpServers() {
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
      } as never,
      tenantSettings: {
        async get() {
          return null;
        },
        async upsert() {
          upsertCalls += 1;
          throw new Error("upsert should not be called");
        }
      }
    },
    {} as SkillBundleStorage,
    makeManagedToolCatalog()
  );

  await expect(() => service.updateTenantSettings("tenant-1", {
        enabledToolIds: ["managed-session-context", "write_artfact"],
        enabledMcpServerIds: ["managed-session-context"]
      })).rejects.toThrow(/Unknown enabled tool IDs: write_artfact\./);
  expect(upsertCalls).toBe(0);
});

test("DynamicConfigService rejects unknown tenant MCP server IDs before persisting settings", async () => {
  let upsertCalls = 0;
  const service = new DynamicConfigService(
    createTestConfig(),
    {
      skills: {} as never,
      skillRevisions: {} as never,
      mcpServers: {
        async listMcpServers() {
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
      } as never,
      tenantSettings: {
        async get() {
          return null;
        },
        async upsert() {
          upsertCalls += 1;
          throw new Error("upsert should not be called");
        }
      }
    },
    {} as SkillBundleStorage,
    makeManagedToolCatalog()
  );

  await expect(() => service.updateTenantSettings("tenant-1", {
        enabledToolIds: ["managed-session-context", "write_artifact"],
        enabledMcpServerIds: ["trusted-ecoh"]
      })).rejects.toThrow(/Unknown enabled MCP server IDs: trusted-ecoh\./);
  expect(upsertCalls).toBe(0);
});
