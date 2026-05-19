import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import JSZip from "jszip";

import { createTestConfig } from "../../test-helpers/test-config.js";
import {
  importSkillBundleFromGithub,
  importSkillBundleFromInline,
  importSkillBundleFromZip
} from "./skill-import-service.js";
import { LocalSkillBundleStorage } from "./skill-bundle-storage.js";
import type { ImportedSkillBundleRecord } from "../admin-config-records.js";

type RecordedImportInput = {
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
};

function buildFakeSkillRevisions(recorder?: { calls: RecordedImportInput[]; storageUris: Array<string | null> }) {
  return {
    async importSkillBundle(_tenantId: string, input: RecordedImportInput) {
      recorder?.calls.push(input);
      const { storageUri } = await input.storeBundle({ revisionNumber: 1 });
      recorder?.storageUris.push(storageUri);
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
          reviewedBy: null,
          reviewedAt: null,
          activatedAt: null
        }
      } as ImportedSkillBundleRecord;
    }
  };
}

test("importSkillBundleFromGithub sends Authorization header when githubToken is provided", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-test-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const storage = new LocalSkillBundleStorage(path.join(root, "cache"));

  const archive = new JSZip();
  archive.file(
    "owner-repo-abc123/test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const capturedHeaders: Record<string, string>[] = [];

  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    capturedHeaders.push({ ...headers, _url: url.toString() });

    const value = url.toString();
    if (value.includes("/repos/owner/repo") && !value.includes("zipball")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (value.includes("/zipball/")) {
      return new Response(new Uint8Array(archiveBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" }
      });
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const TOKEN = "ghs_test_installation_token_12345";

  await importSkillBundleFromGithub({
    tenantId: "test-tenant",
    config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    skillRevisions: buildFakeSkillRevisions(),
    skillBundleStorage: storage,
    githubUrl: "https://github.com/owner/repo",
    actorUserId: "admin-user",
    githubToken: TOKEN,
    fetchFn: fakeFetch as typeof fetch
  });

  expect(capturedHeaders.length >= 2).toBeTruthy();

  const repoLookupCall = capturedHeaders.find((h) => h._url?.includes("/repos/owner/repo") && !h._url?.includes("zipball"));
  const zipballCall = capturedHeaders.find((h) => h._url?.includes("/zipball/"));

  expect(repoLookupCall).toBeTruthy();
  expect(zipballCall).toBeTruthy();

  expect(repoLookupCall.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(zipballCall.Authorization).toBe(`Bearer ${TOKEN}`);
});

test("importSkillBundleFromGithub omits Authorization header when no githubToken is provided", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-notoken-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const storage = new LocalSkillBundleStorage(path.join(root, "cache"));

  const archive = new JSZip();
  archive.file(
    "owner-repo-abc123/test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const capturedHeaders: Record<string, string>[] = [];

  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    capturedHeaders.push({ ...headers, _url: url.toString() });

    const value = url.toString();
    if (value.includes("/repos/owner/repo") && !value.includes("zipball")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (value.includes("/zipball/")) {
      return new Response(new Uint8Array(archiveBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" }
      });
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  await importSkillBundleFromGithub({
    tenantId: "test-tenant",
    config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    skillRevisions: buildFakeSkillRevisions(),
    skillBundleStorage: storage,
    githubUrl: "https://github.com/owner/repo",
    actorUserId: "admin-user",
    fetchFn: fakeFetch as typeof fetch
  });

  for (const headers of capturedHeaders) {
    expect(headers.Authorization).toBe(undefined);
  }
});

test("importSkillBundleFromZip rejects archives with excessive uncompressed size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-zip-size-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  archive.file("test-skill/references/a.txt", "a".repeat(3_000));
  archive.file("test-skill/references/b.txt", "b".repeat(3_000));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  expect(archiveBuffer.byteLength < 5_000).toBeTruthy();

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          ARTIFACT_MAX_UPLOAD_BYTES: 5_000,
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "test-skill.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/maximum uncompressed size/);
});

test("importSkillBundleFromZip auto-promotes single-file SKILL.md zips to inline storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-inline-zip-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "demo-skill/SKILL.md",
    "---\nname: demo-skill\ndescription: A demo skill\n---\n# Demo\nInline content.\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };

  await importSkillBundleFromZip({
    tenantId: "test-tenant",
    config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    skillRevisions: buildFakeSkillRevisions(recorder),
    skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
    archiveBuffer,
    originalFileName: "demo-skill.zip",
    actorUserId: "admin-user"
  });

  expect(recorder.storageUris.length).toBe(1);
  expect(recorder.storageUris[0]).toBe(null);
  expect(recorder.calls[0]?.sourceType).toBe("zip");
});

test("importSkillBundleFromZip persists multi-file bundles to storage (no auto-promotion)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-multi-zip-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "multi-skill/SKILL.md",
    "---\nname: multi-skill\ndescription: A multi-file skill\n---\n# Multi\nUses companion files.\n"
  );
  archive.file("multi-skill/references/notes.md", "extra content");
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };

  await importSkillBundleFromZip({
    tenantId: "test-tenant",
    config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
    skillRevisions: buildFakeSkillRevisions(recorder),
    skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
    archiveBuffer,
    originalFileName: "multi-skill.zip",
    actorUserId: "admin-user"
  });

  expect(recorder.storageUris.length).toBe(1);
  expect(recorder.storageUris[0]).toBeTruthy();
  expect(String(recorder.storageUris[0])).toMatch(/^file:\/\//);
});

test("importSkillBundleFromInline creates an inline revision with no bundle storage", async () => {
  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };

  await importSkillBundleFromInline({
    tenantId: "test-tenant",
    skillRevisions: buildFakeSkillRevisions(recorder),
    skillId: "my-inline-skill",
    skillName: "My Inline Skill",
    description: "A skill created from pasted SKILL.md text.",
    instructions: "# Hello\nThis skill was created inline.\n",
    actorUserId: "admin-user"
  });

  expect(recorder.calls.length).toBe(1);
  const call = recorder.calls[0]!;
  expect(call.sourceType).toBe("inline");
  expect(call.sourceLabel).toBe("inline");
  expect(call.skillId).toBe("my-inline-skill");
  expect(call.skillName).toBe("My Inline Skill");
  expect(call.description).toBe("A skill created from pasted SKILL.md text.");
  expect(call.instructions).toMatch(/This skill was created inline\./);
  expect(recorder.storageUris[0]).toBe(null);
});

test("importSkillBundleFromInline rejects invalid skillId", async () => {
  await expect(importSkillBundleFromInline({
        tenantId: "test-tenant",
        skillRevisions: buildFakeSkillRevisions(),
        skillId: "Invalid_Skill_Id",
        skillName: "Bad",
        description: "Bad",
        instructions: "Bad",
        actorUserId: "admin-user"
      })).rejects.toThrow(/skillId must be 1-64 characters/);
});

test("importSkillBundleFromInline accepts descriptions containing colons and special characters", async () => {
  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };

  // Description with ": " previously broke validation when the synthesized
  // SKILL.md frontmatter used unquoted YAML.
  const trickyDescription = "Python: data tools | analytics";

  await importSkillBundleFromInline({
    tenantId: "test-tenant",
    skillRevisions: buildFakeSkillRevisions(recorder),
    skillId: "tricky-skill",
    skillName: "Tricky",
    description: trickyDescription,
    instructions: "# Body\n",
    actorUserId: "admin-user"
  });

  expect(recorder.calls.length).toBe(1);
  expect(recorder.calls[0]?.description).toBe(trickyDescription);
});

test("importSkillBundleFromInline rejects empty instructions", async () => {
  await expect(importSkillBundleFromInline({
        tenantId: "test-tenant",
        skillRevisions: buildFakeSkillRevisions(),
        skillId: "valid-skill",
        skillName: "Valid",
        description: "Valid",
        instructions: "   \n   ",
        actorUserId: "admin-user"
      })).rejects.toThrow(/instructions is required/);
});
