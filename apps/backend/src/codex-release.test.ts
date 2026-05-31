import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";

import codexRelease from "./codex-release.json" with { type: "json" };
import { createTestConfig } from "./test-helpers/test-config.js";

const backendSrcRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(backendSrcRoot, "../../..");

test("canonical codex release pins stay in sync with static artifacts", async () => {
  const metadataPath = path.join(repoRoot, "schemas", "codex", "metadata.json");
  const backendDockerfilePath = path.join(repoRoot, "docker", "backend.Dockerfile");
  const composePath = path.join(repoRoot, "compose.yaml");
  const initMigrationPath = path.join(repoRoot, "apps", "backend", "db", "migrations", "001_init.sql");
  const retiredTemplateReadmePath = path.join(repoRoot, "docker", "codex-runtime", "README.md");

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    codexVersion: string;
    schemaVersion: string;
  };
  const backendDockerfile = await readFile(backendDockerfilePath, "utf8");
  const compose = await readFile(composePath, "utf8");
  const initMigration = await readFile(initMigrationPath, "utf8");
  const testConfig = createTestConfig();

  expect(metadata.codexVersion).toBe(codexRelease.codexVersion);
  expect(metadata.schemaVersion).toBe(codexRelease.schemaVersion);
  // NOTE: we deliberately do NOT grep template.ts for `release.codexVersion` /
  // `release.claudeAgentSdkVersion`. That asserted source *text* (how the value
  // is wired) rather than behavior, and broke on harmless refactors. The pins
  // that actually ship — the Dockerfile ARG, compose env, and the backend's
  // installed SDK dependency — are verified below against codex-release.json.
  expect(backendDockerfile).toMatch(new RegExp(`ARG CODEX_NPM_VERSION=${escapeForRegex(codexRelease.codexVersion)}`));
  expect(compose).toMatch(new RegExp(`CODEX_NPM_VERSION:\\s+${escapeForRegex(codexRelease.codexVersion)}`));
  expect(compose).toMatch(new RegExp(`CODEX_VERSION:\\s+${escapeForRegex(codexRelease.codexVersion)}`));
  // Guard: `codex_version` must not have a DEFAULT — the per-row pin is set
  // explicitly when a runtime starts, so any default would mask a wiring bug
  // (see migration 015 in the pre-squash history). The squashed init is
  // produced by `pg_dump` which lowercases type names; match either case.
  expect(initMigration).toMatch(/codex_version\s+(?:text|TEXT) NOT NULL,/);
  expect(initMigration).not.toMatch(/codex_version\s+(?:text|TEXT) NOT NULL DEFAULT/);
  expect(testConfig.CODEX_VERSION).toBe(codexRelease.codexVersion);
  expect(testConfig.CODEX_SCHEMA_VERSION).toBe(codexRelease.schemaVersion);
  expect(testConfig.E2B_TEMPLATE_ID).toBe(codexRelease.e2bTemplateId);
  expect(testConfig.CLAUDE_AGENT_SDK_VERSION).toBe(codexRelease.claudeAgentSdkVersion);
  // The backend's installed SDK must also match so local-mode
  // `import("@anthropic-ai/claude-agent-sdk")` and the sandbox-installed SDK
  // stay in lockstep (otherwise protocol drift can silently break e2b turns).
  const backendPackageJson = JSON.parse(
    await readFile(path.join(repoRoot, "apps", "backend", "package.json"), "utf8")
  ) as { dependencies: Record<string, string> };
  expect(backendPackageJson.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(codexRelease.claudeAgentSdkVersion);
  // Sandbox-agent harness must be present for `make e2b-build` to find it
  const harnessPath = path.join(repoRoot, "docker", "sandbox-agent", "sandbox-agent.mjs");
  expect(await pathExists(harnessPath)).toBe(true);
  expect(await pathExists(retiredTemplateReadmePath)).toBe(false);
});

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
