import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import type { RuntimeManifest } from "../../domain/runtime-manifest.js";

import { createRuntimeWorkspace } from "./runtime-workspace.js";
import { verifyRuntimeToken } from "../auth/runtime-token.js";
import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { registerBuiltinManagedTools } from "../managed-tools/register-builtin-managed-tools.js";
import { LocalSkillBundleStorage } from "../skills/skill-bundle-storage.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

function makeTestManagedToolCatalog(): ManagedToolCatalog {
  const catalog = new ManagedToolCatalog();
  registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
  return catalog;
}

const runtimeConfig = {
  runtimePolicy: {
    id: "phase4-tools",
    label: "Phase 4 tools",
    description: null,
    runtimeProvider: "codex" as const,
    webSearchMode: "disabled" as const,
    approvalPolicy: "on-request" as const,
    sandboxMode: "workspace-write" as const,
    networkMode: "restricted" as const,
    allowCommandExecution: true,
    allowUserTokenForwarding: true,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor" as const,
    enabledToolIds: ["managed-session-context", "session_context"],
    enabledMcpServers: ["managed-session-context"],
    version: 1,
    hash: "hash-phase4-tools"
  },
  skills: [
    {
      id: "document_analysis",
      name: "Document analysis",
      description: null,
      instructions: "Use the current artifact scope before answering.",
      version: 3,
      hash: "hash-skill-document-analysis",
      revisionId: 9,
      bundleHash: "hash-skill-document-analysis",
      sourceType: "zip",
      bundleName: "document-analysis",
      bundleStorageUri: null,
      validationStatus: "validated",
      reviewStatus: "active"
    }
  ],
  mcpServers: [] as Array<{
    id: string;
    description: string;
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl: string | null;
    transportKind: "http";
    headersAllowlist: string[];
    version: number;
    hash: string;
  }>,
  hash: "hash-config-bundle",
  sources: {
    runtimePolicy: {
      id: "phase4-tools",
      version: 1,
      hash: "hash-phase4-tools"
    },
      skills: [
        {
          id: "document_analysis",
          version: 3,
          hash: "hash-skill-document-analysis",
          revisionId: 9,
          bundleHash: "hash-skill-document-analysis"
        }
      ],
    mcpServers: []
  }
};

test("createRuntimeWorkspace keeps runtime files inside the configured root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "11111111-1111-1111-1111-111111111111",
      tenantId: "tenant-1",
      userId: "../../escape",
      runtimeId: "runtime-1",
      runtimeConfig,
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-1")),
      managedToolCatalog: makeTestManagedToolCatalog()
    }
  );

  expect(workspace.workspacePath.startsWith(`${root}${path.sep}`)).toBeTruthy();
  expect(workspace.codexTomlPath.startsWith(`${root}${path.sep}`)).toBeTruthy();
  expect(workspace.manifestPath.startsWith(`${root}${path.sep}`)).toBeTruthy();
  expect(workspace.workspacePath).toMatch(/user-/);

  const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as RuntimeManifest;
  expect(manifest.userId).toBe("../../escape");
  expect(manifest.skills[0]?.revisionId).toBe(9);
  expect(manifest.skills[0]?.bundleHash).toBe("hash-skill-document-analysis");
});

test("createRuntimeWorkspace writes MCP servers using Codex mcp_servers config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-mcp-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "22222222-2222-2222-2222-222222222222",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-2",
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-2")),
      managedToolCatalog: makeTestManagedToolCatalog(),
      runtimeConfig: {
        ...runtimeConfig,
        mcpServers: [
          {
            id: "managed-session-context",
            description: "Managed session artifacts",
            mode: "managed",
            routePath: "/mcp/managed-session-context",
            upstreamUrl: null,
            transportKind: "http",
            headersAllowlist: [],
            version: 2,
            hash: "hash-managed-session-context"
          }
        ],
        hash: "hash-config-bundle-with-mcp",
        sources: {
          ...runtimeConfig.sources,
          mcpServers: [
            {
              id: "managed-session-context",
              version: 2,
              hash: "hash-managed-session-context"
            }
          ],
          skills: [
            {
              id: "document_analysis",
              version: 3,
              hash: "hash-skill-document-analysis",
              revisionId: 9,
              bundleHash: "hash-skill-document-analysis"
            }
          ]
        }
      }
    }
  );

  const codexToml = await readFile(workspace.codexTomlPath, "utf8");
  const agentsMd = await readFile(path.join(workspace.workspacePath, "AGENTS.md"), "utf8");
  const skillFile = await readFile(
    path.join(workspace.manifest.config.skillsPath, "document-analysis", "SKILL.md"),
    "utf8"
  );
  expect(codexToml).toMatch(/\[mcp_servers\.managed-session-context\]/);
  expect(codexToml).toMatch(/url = "http:\/\/localhost:3001\/mcp\/managed-session-context\?token=rt_/);
  expect(codexToml).not.toMatch(/\[mcp\]/);
  // web_search is omitted entirely when the mode is "disabled".
  expect(codexToml).not.toMatch(/web_search/);
  expect(agentsMd).toMatch(/Do not narrate your step-by-step investigation/);
  expect(agentsMd).toMatch(/Do not search the local workspace as a substitute/);
  expect(agentsMd).toMatch(/list the OneDrive root before falling back to search/);
  expect(agentsMd).toMatch(/Do not use `list_mcp_resources` or `list_mcp_resource_templates`/);
  expect(skillFile).toMatch(/document_analysis/);
  expect(skillFile).toMatch(/Use the current artifact scope before answering/);

  const verification = verifyRuntimeToken(workspace.runtimeToken, createTestConfig().DATA_ENCRYPTION_SECRET);
  expect(verification.kind).toBe("valid");
  if (verification.kind !== "valid") return;
  const { claims } = verification;
  expect(claims.sid).toBe("22222222-2222-2222-2222-222222222222");
  expect(claims.tid).toBe("tenant-1");
  expect(claims.uid).toBe("test-user");
  expect(claims.rid).toBe("runtime-2");
  expect(claims.exp).toBeTruthy();
  const expiresAt = new Date(claims.exp!).getTime();
  const now = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  expect(expiresAt > now).toBeTruthy();
  expect(Math.abs(expiresAt - (now + twentyFourHoursMs)) < 60_000).toBeTruthy();
});

test("createRuntimeWorkspace writes token-bearing files with mode 0600 on POSIX", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-perms-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "33333333-3333-3333-3333-333333333333",
      tenantId: "tenant-1",
      userId: "perm-user",
      runtimeId: "runtime-perm",
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-perm")),
      managedToolCatalog: makeTestManagedToolCatalog(),
      runtimeConfig
    }
  );

  const codexTomlMode = (await stat(workspace.codexTomlPath)).mode & 0o777;
  expect(codexTomlMode).toBe(0o600);
  const manifestMode = (await stat(workspace.manifestPath)).mode & 0o777;
  expect(manifestMode).toBe(0o600);
  const workspaceDirMode = (await stat(workspace.workspacePath)).mode & 0o777;
  expect(workspaceDirMode).toBe(0o700);
});

test("createRuntimeWorkspace installs full bundle directories when bundle metadata is present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-bundle-"));
  const bundleRoot = path.join(root, "bundle-source", "pdf-processing");
  await mkdir(path.join(bundleRoot, "references"), { recursive: true });
  await writeFile(
    path.join(bundleRoot, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse the reference files.\n"
  );
  await writeFile(path.join(bundleRoot, "references", "REFERENCE.md"), "Bundle reference");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "33333333-3333-3333-3333-333333333333",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-3",
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-3")),
      managedToolCatalog: makeTestManagedToolCatalog(),
      runtimeConfig: {
        ...runtimeConfig,
        skills: [
          {
            ...runtimeConfig.skills[0],
            id: "pdf-processing",
            name: "PDF processing",
            sourceType: "github",
            bundleName: "pdf-processing",
            bundleStorageUri: `file://${bundleRoot}`,
            validationStatus: "validated",
            reviewStatus: "active"
          }
        ],
        sources: {
          ...runtimeConfig.sources,
          skills: [
            {
              id: "pdf-processing",
              version: 3,
              hash: "hash-skill-document-analysis",
              revisionId: 9,
              bundleHash: "hash-skill-document-analysis"
            }
          ]
        }
      }
    }
  );

  const installedSkill = await readFile(
    path.join(workspace.manifest.config.skillsPath, "pdf-processing", "references", "REFERENCE.md"),
    "utf8"
  );
  expect(installedSkill).toBe("Bundle reference");
  expect(workspace.manifest.skills[0]?.sourceType).toBe("github");
  expect(workspace.manifest.skills[0]?.revisionId).toBe(9);
  expect(workspace.manifest.skills[0]?.bundleHash).toBe("hash-skill-document-analysis");
});

test("createRuntimeWorkspace removes stale generated skills when reusing a session workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-refresh-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const firstWorkspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "44444444-4444-4444-4444-444444444444",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-4",
      runtimeConfig,
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-4")),
      managedToolCatalog: makeTestManagedToolCatalog()
    }
  );

  await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "44444444-4444-4444-4444-444444444444",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-5",
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-5")),
      managedToolCatalog: makeTestManagedToolCatalog(),
      runtimeConfig: {
        ...runtimeConfig,
        skills: [
          {
            ...runtimeConfig.skills[0],
            id: "replacement-skill",
            name: "Replacement skill",
            bundleName: "replacement-skill"
          }
        ],
        sources: {
          ...runtimeConfig.sources,
          skills: [
            {
              id: "replacement-skill",
              version: 3,
              hash: "hash-skill-replacement",
              revisionId: 9,
              bundleHash: "hash-skill-replacement"
            }
          ]
        }
      }
    }
  );

  const skillDirectoryEntries = (await readdir(firstWorkspace.manifest.config.skillsPath)).sort();
  expect(skillDirectoryEntries).toEqual(["replacement-skill"]);
});

test("createRuntimeWorkspace YAML-escapes skill descriptions containing special characters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-yaml-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Description with ": " was the documented break case — bare YAML treats it
  // as a nested key/value mapping and either parses wrong or fails.
  const trickyDescription = "Python: data tools | for: BI users";

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "33333333-3333-3333-3333-333333333333",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-yaml",
      runtimeConfig: {
        ...runtimeConfig,
        skills: [
          {
            ...runtimeConfig.skills[0],
            description: trickyDescription
          }
        ]
      },
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-yaml")),
      managedToolCatalog: makeTestManagedToolCatalog()
    }
  );

  const skillFilePath = path.join(
    workspace.manifest.config.skillsPath,
    "document-analysis",
    "SKILL.md"
  );
  const skillFile = await readFile(skillFilePath, "utf8");

  // Parse the frontmatter back to confirm it round-trips intact.
  const frontmatterMatch = skillFile.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatterMatch).toBeTruthy();
  const YAML = (await import("yaml")).default;
  const parsed = YAML.parse(frontmatterMatch![1]) as { name: string; description: string };
  expect(parsed.name).toBe("document_analysis");
  expect(parsed.description).toBe(trickyDescription);
});

// MCP transport contract: Codex's Streamable HTTP transport does not forward
// `Authorization` headers on the `initialize` POST, so the runtime token MUST
// be embedded as `?token=rt_...` in the codex.toml URL. The Claude side
// enforces the inverse (header-only) — see claude-workspace-renderer.test.ts.
test("codex.toml MCP URLs carry the runtime token in ?token= (transport contract)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-codex-token-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: root
    },
    {
      sessionId: "55555555-5555-5555-5555-555555555555",
      tenantId: "tenant-1",
      userId: "test-user",
      runtimeId: "runtime-codex-token",
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache-token")),
      managedToolCatalog: makeTestManagedToolCatalog(),
      runtimeConfig: {
        ...runtimeConfig,
        mcpServers: [
          {
            id: "managed-session-context",
            description: "Managed session artifacts",
            mode: "managed",
            routePath: "/mcp/managed-session-context",
            upstreamUrl: null,
            transportKind: "http",
            headersAllowlist: [],
            version: 2,
            hash: "hash-managed-session-context"
          }
        ],
        hash: "hash-config-bundle-token",
        sources: {
          ...runtimeConfig.sources,
          mcpServers: [
            {
              id: "managed-session-context",
              version: 2,
              hash: "hash-managed-session-context"
            }
          ]
        }
      }
    }
  );

  const codexToml = await readFile(workspace.codexTomlPath, "utf8");
  // Token must be present as `?token=rt_...` on the URL.
  expect(codexToml).toMatch(/url = "http:\/\/localhost:3001\/mcp\/managed-session-context\?token=rt_[A-Za-z0-9._-]+"/);
});

test("createRuntimeWorkspace writes the web_search key when the mode is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-workspace-websearch-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  for (const mode of ["cached", "live"] as const) {
    const workspace = await createRuntimeWorkspace(
      {
        ...createTestConfig(),
        RUNTIME_WORKSPACE_ROOT: root
      },
      {
        sessionId: "66666666-6666-6666-6666-666666666666",
        tenantId: "tenant-1",
        userId: "test-user",
        runtimeId: `runtime-websearch-${mode}`,
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, `bundle-cache-${mode}`)),
        managedToolCatalog: makeTestManagedToolCatalog(),
        runtimeConfig: {
          ...runtimeConfig,
          runtimePolicy: { ...runtimeConfig.runtimePolicy, webSearchMode: mode }
        }
      }
    );

    const codexToml = await readFile(workspace.codexTomlPath, "utf8");
    expect(codexToml).toMatch(new RegExp(`^web_search = "${mode}"$`, "m"));

    const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as RuntimeManifest;
    expect(manifest.runtimePolicy.webSearchMode).toBe(mode);
  }
});
