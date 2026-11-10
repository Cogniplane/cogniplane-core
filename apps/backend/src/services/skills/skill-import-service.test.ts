import { Response, type fetch as undiciFetch, type RequestInit } from "undici";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { test, expect, onTestFinished, vi } from "vitest";

import JSZip from "jszip";

import { createTestConfig } from "../../test-helpers/test-config.js";
import {
  importSkillBundleFromGithub,
  importSkillBundleFromInline,
  importSkillBundleFromZip,
  ssrfSafeGithubFetch,
  MAX_GITHUB_REDIRECTS
} from "./skill-import-service.js";
import { AdminConfigError } from "../admin-config-error.js";
import { MAX_GITHUB_ARCHIVE_ENTRIES, MAX_SKILL_BUNDLE_FILES } from "./skill-bundle-limits.js";
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
  storeBundle: () => Promise<{ storageUri: string | null }>;
};

function buildFakeSkillRevisions(recorder?: { calls: RecordedImportInput[]; storageUris: Array<string | null> }) {
  return {
    async importSkillBundle(
      _tenantId: string,
      input: RecordedImportInput
    ): Promise<ImportedSkillBundleRecord> {
      recorder?.calls.push(input);
      const { storageUri } = await input.storeBundle();
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
          isPublished: false,
          createdBy: input.createdBy,
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
      };
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
    fetchFn: fakeFetch as typeof undiciFetch
  });

  expect(capturedHeaders.length >= 2).toBeTruthy();

  const repoLookupCall = capturedHeaders.find((h) => h._url?.includes("/repos/owner/repo") && !h._url?.includes("zipball"));
  const zipballCall = capturedHeaders.find((h) => h._url?.includes("/zipball/"));

  expect(repoLookupCall).toBeTruthy();
  expect(zipballCall).toBeTruthy();

  expect(repoLookupCall?.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(zipballCall?.Authorization).toBe(`Bearer ${TOKEN}`);
});

test("importSkillBundleFromGithub rejects a nonexistent subdirectory as AdminConfigError", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-subdir-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "owner-repo-abc123/test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const fakeFetch = async (url: string | URL) => {
    const value = url.toString();
    if (value.includes("/zipball/")) {
      return new Response(new Uint8Array(archiveBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" }
      });
    }
    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  await expect(importSkillBundleFromGithub({
        tenantId: "test-tenant",
        config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        githubUrl: "https://github.com/owner/repo/tree/main/missing-dir",
        actorUserId: "admin-user",
        fetchFn: fakeFetch as typeof undiciFetch
      })).rejects.toThrow(AdminConfigError);
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
    fetchFn: fakeFetch as typeof undiciFetch
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
      })).rejects.toThrow(/exceeds the maximum uncompressed size|expands past the \d+-byte limit/);
});

test("importSkillBundleFromZip rejects a zip bomb before inflating it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-zipbomb-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // A zip bomb: 5 MB of a single repeated byte, which DEFLATE crushes to a
  // few KB. Every declared-size check passes if the header is then rewritten
  // to a small lie — so the only thing that can stop this is a bound on how
  // much the entry is allowed to expand relative to the compressed bytes
  // actually present, applied BEFORE decompression.
  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  archive.file("test-skill/references/bomb.txt", "A".repeat(5_000_000));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // A few KB on the wire, 5 MB on disk. That gap is the attack.
  expect(archiveBuffer.byteLength).toBeLessThan(100_000);

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "bomb.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/expands past the \d+-byte limit allowed for its \d+ compressed bytes/);
});

test("importSkillBundleFromZip rejects many entries that individually pass every declared check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-multibomb-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // The test pads each entry with incompressible random bytes, so its real ratio
  // stays far below the ratio cap. It then rewrites every declared size to 64
  // bytes, so every declared check passes. The archive really inflates to about
  // 32 MB, which is more than the 25 MB total budget.
  //
  // The importer caps the inflate of each entry at the bytes left in that budget,
  // so a later entry is refused. Pin this: the cap must hold while inflating,
  // because the declared sizes cannot be trusted.
  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  for (let i = 0; i < 40; i += 1) {
    const incompressible = randomBytes(12_000).toString("base64");
    archive.file(`test-skill/references/pad-${i}.txt`, `${incompressible}${"Z".repeat(800_000)}`);
  }
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const lie = 64;
  for (let i = 0; i + 4 <= archiveBuffer.byteLength; i += 1) {
    const sig = archiveBuffer.readUInt32LE(i);
    if (sig === LOCAL_SIG && i + 26 <= archiveBuffer.byteLength) {
      archiveBuffer.writeUInt32LE(lie, i + 22);
    } else if (sig === CENTRAL_SIG && i + 28 <= archiveBuffer.byteLength) {
      archiveBuffer.writeUInt32LE(lie, i + 24);
    }
  }

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "multi.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/expands past the \d+-byte limit allowed for its \d+ compressed bytes/);
}, 30_000);

test("importSkillBundleFromZip rejects a bomb whose header also lies about its size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-zipbomb-lie-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  archive.file("test-skill/references/bomb.txt", "A".repeat(20_000_000));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // Rewrite every 4-byte uncompressed-size field (local header offset 22,
  // central-directory offset 24) to a harmless-looking value, so the declared
  // size caps see a 64-byte file. The bounded inflate must still refuse it.
  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const lie = 64;
  for (let i = 0; i + 4 <= archiveBuffer.byteLength; i += 1) {
    const sig = archiveBuffer.readUInt32LE(i);
    if (sig === LOCAL_SIG && i + 26 <= archiveBuffer.byteLength) {
      archiveBuffer.writeUInt32LE(lie, i + 22);
    } else if (sig === CENTRAL_SIG && i + 28 <= archiveBuffer.byteLength) {
      archiveBuffer.writeUInt32LE(lie, i + 24);
    }
  }

  // The declared size says 64 bytes, so the declared checks pass. The inflate is
  // still bounded by two limits: the compressed size (times the ratio cap) and the
  // per-file byte cap. Here it stops at the 10 MB per-file cap. That bound is why
  // running it is safe.
  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "bomb.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/expands past the \d+-byte limit allowed for its \d+ compressed bytes/);
  // That inflation takes about a second alone and more on a loaded runner, so
  // this test gets the same limit as the bomb test above.
}, 30_000);

test("importSkillBundleFromZip accepts a bundle with ordinary text compression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-ratio-ok-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Real prose compresses maybe 3-5x, nowhere near the 1000:1 bound. The ratio
  // check must not become a limit on legitimate bundles.
  const prose = Array.from(
    { length: 400 },
    (_, i) => `Line ${i}: guidance about writing a good skill, with varied wording and punctuation.`
  ).join("\n");

  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    `---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\n${prose}\n`
  );
  archive.file("test-skill/references/notes.md", prose);
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "test-skill.zip",
        actorUserId: "admin-user"
      })).resolves.toBeDefined();
});

test("importSkillBundleFromZip handles STORE-compressed (uncompressed) entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-store-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Method 0 has no compressed stream to inflate, so `inflateEntryBounded`
  // returns the raw bytes on a separate branch. Archives written by some tools
  // (and any already-compressed file) take it, so it needs its own coverage.
  // The two methods take different code paths.
  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nStored entry instructions.\n",
    { compression: "STORE" }
  );
  archive.file("test-skill/references/notes.md", "Companion file, stored verbatim.", {
    compression: "STORE"
  });
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "STORE" });

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer,
        originalFileName: "stored.zip",
        actorUserId: "admin-user"
      })).resolves.toBeDefined();
});

test("importSkillBundleFromZip rejects malformed (non-zip) bytes as AdminConfigError, not a library error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-badzip-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  await expect(importSkillBundleFromZip({
        tenantId: "test-tenant",
        config: createTestConfig({
          SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache")
        }),
        skillRevisions: buildFakeSkillRevisions(),
        skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
        archiveBuffer: Buffer.from("this is definitely not a zip archive"),
        originalFileName: "not-a-zip.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(AdminConfigError);
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

  // A description with ": " must stay valid in the synthesized SKILL.md frontmatter.
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

type FakeHop = { url: string; headers: Record<string, string> };

/**
 * Builds a fetch fake that returns each scripted Response in order and
 * records the URL + headers it was invoked with on every hop, so the
 * production redirect loop runs unmodified.
 */
function makeRedirectFake(responses: Response[]): { fake: typeof undiciFetch; hops: FakeHop[] } {
  const hops: FakeHop[] = [];
  let index = 0;
  const fake: typeof undiciFetch = async (url, init) => {
    hops.push({
      url: url.toString(),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) }
    });
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error(`No scripted response for hop ${index} (${url.toString()})`);
    }
    return response;
  };
  return { fake, hops };
}

test("ssrfSafeGithubFetch blocks a redirect to a private/reserved host (SSRF)", async () => {
  const { fake } = makeRedirectFake([
    new Response(null, {
      status: 302,
      // 169.254.169.254 is the cloud IMDS endpoint — a classic SSRF target.
      headers: { location: "https://169.254.169.254/latest/meta-data/" }
    })
  ]);

  await expect(
    ssrfSafeGithubFetch("https://api.github.com/repos/owner/repo/zipball/main", {}, fake)
  ).rejects.toThrow(/resolves to a private or reserved address/);
});

test("ssrfSafeGithubFetch blocks a redirect to a non-https private host (SSRF)", async () => {
  const { fake } = makeRedirectFake([
    new Response(null, {
      status: 302,
      headers: { location: "http://10.0.0.1/internal" }
    })
  ]);

  // A plain-http private target is rejected on the scheme check before the
  // host check ever runs — either way the redirect is refused.
  await expect(
    ssrfSafeGithubFetch("https://api.github.com/repos/owner/repo/zipball/main", {}, fake)
  ).rejects.toThrow(/must use the https:\/\/ scheme/);
});

test("ssrfSafeGithubFetch deletes the Authorization header on a cross-origin redirect", async () => {
  const archivePayload = new Uint8Array([1, 2, 3]);
  const { fake, hops } = makeRedirectFake([
    new Response(null, {
      status: 302,
      // github.com zipball 302s to a presigned codeload host — different origin.
      headers: { location: "https://codeload.github.com/owner/repo/legacy.zip/main" }
    }),
    new Response(archivePayload, { status: 200 })
  ]);

  const response = await ssrfSafeGithubFetch(
    "https://api.github.com/repos/owner/repo/zipball/main",
    { headers: { Authorization: "Bearer ghs_secret_token", "User-Agent": "cogniplane-core" } },
    fake
  );

  expect(response.status).toBe(200);
  expect(hops.length).toBe(2);
  // First (same-origin entry) hop carries the token...
  expect(hops[0]?.headers.Authorization).toBe("Bearer ghs_secret_token");
  expect(hops[0]?.url).toContain("api.github.com");
  // ...the second hop, after crossing to codeload.github.com, must NOT.
  expect(hops[1]?.url).toContain("codeload.github.com");
  expect(hops[1]?.headers.Authorization).toBeUndefined();
  // Non-auth headers ride along across the redirect.
  expect(hops[1]?.headers["User-Agent"]).toBe("cogniplane-core");
});

test("ssrfSafeGithubFetch retains the Authorization header on a same-origin redirect", async () => {
  const { fake, hops } = makeRedirectFake([
    new Response(null, {
      status: 302,
      // Relative redirect resolves against the same origin (api.github.com).
      headers: { location: "/repos/owner/repo/zipball/main?after=redirect" }
    }),
    new Response(new Uint8Array([9]), { status: 200 })
  ]);

  const response = await ssrfSafeGithubFetch(
    "https://api.github.com/repos/owner/repo/zipball/main",
    { headers: { Authorization: "Bearer ghs_secret_token" } },
    fake
  );

  expect(response.status).toBe(200);
  expect(hops.length).toBe(2);
  expect(hops[1]?.url).toContain("api.github.com");
  expect(hops[1]?.headers.Authorization).toBe("Bearer ghs_secret_token");
});

test("ssrfSafeGithubFetch throws after exceeding the maximum redirect count", async () => {
  // Always redirect (same origin so the host check never short-circuits the
  // loop) so the hop counter is the only thing that can terminate it.
  const responses = Array.from({ length: MAX_GITHUB_REDIRECTS + 2 }, () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://api.github.com/repos/owner/repo/next" }
    })
  );
  const { fake, hops } = makeRedirectFake(responses);

  await expect(
    ssrfSafeGithubFetch("https://api.github.com/repos/owner/repo/zipball/main", {}, fake)
  ).rejects.toThrow(/exceeded the maximum number of redirects/);

  // The loop runs hops 0..MAX inclusive before giving up.
  expect(hops.length).toBe(MAX_GITHUB_REDIRECTS + 1);
});

test("ssrfSafeGithubFetch returns a 3xx with no Location header as-is", async () => {
  const { fake, hops } = makeRedirectFake([new Response(null, { status: 304 })]);

  const response = await ssrfSafeGithubFetch(
    "https://api.github.com/repos/owner/repo/zipball/main",
    {},
    fake
  );

  expect(response.status).toBe(304);
  expect(hops.length).toBe(1);
});

test("importSkillBundleFromZip rejects path-traversal (zip-slip) entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-zipslip-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const archive = new JSZip();
  archive.file(
    "evil-skill/SKILL.md",
    "---\nname: evil-skill\ndescription: A skill\n---\n# Body\n"
  );
  // JSZip collapses "../" segments both when adding a file and when re-reading
  // the archive, so a literal "../evil.txt" cannot survive a round-trip. An
  // ABSOLUTE-path entry ("/evil.txt") is the zip-slip vector that does survive
  // loadAsync — it would escape the extraction root, and normalizeZipEntryPath
  // rejects it. We post-process the internal files map because JSZip's public
  // .file() API would otherwise sanitize the leading slash on write.
  archive.file("evil-skill/__placeholder.txt", "pwned");
  const malicious = archive.files["evil-skill/__placeholder.txt"]!;
  malicious.name = "/evil.txt";
  archive.files["/evil.txt"] = malicious;
  delete archive.files["evil-skill/__placeholder.txt"];

  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  await expect(
    importSkillBundleFromZip({
      tenantId: "test-tenant",
      config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
      skillRevisions: buildFakeSkillRevisions(),
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
      archiveBuffer,
      originalFileName: "evil-skill.zip",
      actorUserId: "admin-user"
    })
  ).rejects.toThrow(/Unsafe zip entry path/);
});

test("importSkillBundleFromZip rejects archives exceeding the maximum file count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-filecount-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const archive = new JSZip();
  archive.file(
    "big-skill/SKILL.md",
    "---\nname: big-skill\ndescription: A skill\n---\n# Body\n"
  );
  // SKILL.md plus 50 companion files = 51 files, one over MAX_SKILL_BUNDLE_FILES.
  for (let i = 0; i < 50; i += 1) {
    archive.file(`big-skill/references/file-${i}.txt`, `content ${i}`);
  }
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  await expect(
    importSkillBundleFromZip({
      tenantId: "test-tenant",
      config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache") }),
      skillRevisions: buildFakeSkillRevisions(),
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
      archiveBuffer,
      originalFileName: "big-skill.zip",
      actorUserId: "admin-user"
    })
  ).rejects.toThrow(/maximum file count/);
});

// GitHub zipballs hold a whole repository under one `owner-repo-sha/` folder.
// The importer must choose the skill folder from the entry names, and apply the
// bundle limits and the bounded inflate to that folder only.
const ZIPBALL_ROOT = "owner-repo-abc123";

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n`;
}

function addUnrelatedFiles(archive: JSZip, folder: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    archive.file(`${ZIPBALL_ROOT}/${folder}/file-${i}.md`, `Unrelated repository file ${i}.\n`);
  }
}

function zipballFetch(archiveBuffer: Buffer): typeof undiciFetch {
  return (async (url: string | URL) => {
    const value = url.toString();
    if (value.includes("/zipball/")) {
      return new Response(new Uint8Array(archiveBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" }
      });
    }
    if (value.endsWith("/repos/owner/repo")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch URL: ${value}`);
  }) as typeof undiciFetch;
}

async function importZipball(
  archiveBuffer: Buffer,
  options: {
    githubUrl?: string;
    ref?: string;
    subdirectory?: string;
    config?: Parameters<typeof createTestConfig>[0];
    recorder?: { calls: RecordedImportInput[]; storageUris: Array<string | null> };
  } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-zipball-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return importSkillBundleFromGithub({
    tenantId: "test-tenant",
    config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: path.join(root, "cache"), ...options.config }),
    skillRevisions: buildFakeSkillRevisions(options.recorder),
    skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "cache")),
    githubUrl: options.githubUrl ?? "https://github.com/owner/repo",
    ref: options.ref,
    subdirectory: options.subdirectory,
    actorUserId: "admin-user",
    fetchFn: zipballFetch(archiveBuffer)
  });
}

type CentralRecord = { name: string; centralOffset: number; localOffset: number };

// Reads the central directory of an archive this file generated (no comment,
// no zip64), so a test can edit the fields of one named entry.
function readCentralRecords(archiveBuffer: Buffer): CentralRecord[] {
  const endOffset = archiveBuffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const recordCount = archiveBuffer.readUInt16LE(endOffset + 10);
  let offset = archiveBuffer.readUInt32LE(endOffset + 16);
  const records: CentralRecord[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    const nameLength = archiveBuffer.readUInt16LE(offset + 28);
    const extraLength = archiveBuffer.readUInt16LE(offset + 30);
    const commentLength = archiveBuffer.readUInt16LE(offset + 32);
    records.push({
      name: archiveBuffer.toString("utf8", offset + 46, offset + 46 + nameLength),
      centralOffset: offset,
      localOffset: archiveBuffer.readUInt32LE(offset + 42)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

function findCentralRecord(archiveBuffer: Buffer, name: string): CentralRecord {
  const record = readCentralRecords(archiveBuffer).find((candidate) => candidate.name === name);
  if (!record) {
    throw new Error(`No zip entry named ${name}`);
  }
  return record;
}

/** Make an entry declare `size` uncompressed bytes in both of its headers. */
function rewriteDeclaredSize(archiveBuffer: Buffer, name: string, size: number): void {
  const record = findCentralRecord(archiveBuffer, name);
  archiveBuffer.writeUInt32LE(size, record.centralOffset + 24);
  archiveBuffer.writeUInt32LE(size, record.localOffset + 22);
}

/**
 * Make the deflate stream of an entry start with a reserved block type, so any
 * attempt to inflate it fails. An import that succeeds proves it never
 * inflated the entry.
 */
function corruptDeflateData(archiveBuffer: Buffer, name: string): void {
  const record = findCentralRecord(archiveBuffer, name);
  const nameLength = archiveBuffer.readUInt16LE(record.localOffset + 26);
  const extraLength = archiveBuffer.readUInt16LE(record.localOffset + 28);
  archiveBuffer[record.localOffset + 30 + nameLength + extraLength] = 0xff;
}

function recordedFilePaths(recorder: { calls: RecordedImportInput[] }): string[] {
  const files = recorder.calls[0]?.metadata.files as Array<{ path: string }> | undefined;
  return (files ?? []).map((file) => file.path);
}

test("importSkillBundleFromGithub imports a small skill folder from a repository with more than 50 unrelated files", async () => {
  const archive = new JSZip();
  addUnrelatedFiles(archive, "docs", 80);
  addUnrelatedFiles(archive, "src/lib", 80);
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/notes.md`, "Companion notes.\n");
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };
  // The marketplace sends the repository URL, ref and subdirectory as separate
  // fields, so this input has the marketplace shape.
  const imported = await importZipball(archiveBuffer, {
    ref: "main",
    subdirectory: "skills/demo-skill",
    recorder
  });

  expect(imported.skill.skillId).toBe("demo-skill");
  expect(recorder.calls[0]?.sourceLabel).toBe("owner/repo@main");
  expect(recordedFilePaths(recorder)).toEqual(["references/notes.md", "SKILL.md"]);
  expect(recorder.storageUris[0]).toMatch(/^file:\/\//);
});

test("importSkillBundleFromGithub does not inflate oversized, lying or corrupt entries outside the selected folder", async () => {
  const archive = new JSZip();
  // Honest but larger than the per-file cap.
  archive.file(`${ZIPBALL_ROOT}/vendor/huge.bin`, "A".repeat(11 * 1024 * 1024));
  // Inflates past the per-file cap; its headers say 64 bytes (rewritten below).
  archive.file(`${ZIPBALL_ROOT}/vendor/bomb.txt`, "B".repeat(12 * 1024 * 1024));
  // Any inflate of this entry throws (corrupted below).
  archive.file(`${ZIPBALL_ROOT}/vendor/corrupt.txt`, "This deflate stream gets corrupted.\n".repeat(20));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  rewriteDeclaredSize(archiveBuffer, `${ZIPBALL_ROOT}/vendor/bomb.txt`, 64);
  corruptDeflateData(archiveBuffer, `${ZIPBALL_ROOT}/vendor/corrupt.txt`);

  const imported = await importZipball(archiveBuffer, {
    githubUrl: "https://github.com/owner/repo/tree/main/skills/demo-skill"
  });

  expect(imported.skill.skillId).toBe("demo-skill");
}, 30_000);

test("importSkillBundleFromGithub keeps the file-count limit on the selected folder", async () => {
  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/big-skill/SKILL.md`, skillMarkdown("big-skill"));
  // SKILL.md plus 50 companion files = 51 files, one over MAX_SKILL_BUNDLE_FILES.
  for (let i = 0; i < 50; i += 1) {
    archive.file(`${ZIPBALL_ROOT}/skills/big-skill/references/file-${i}.txt`, `content ${i}`);
  }
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  await expect(importZipball(archiveBuffer, { subdirectory: "skills/big-skill" }))
    .rejects.toThrow(/maximum file count of 50/);
});

test("importSkillBundleFromGithub keeps the per-file limit on the selected folder", async () => {
  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/big.txt`, "A".repeat(11 * 1024 * 1024));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill" }))
    .rejects.toThrow(/references\/big\.txt exceeds the maximum file size of 10485760 bytes/);
});

test("importSkillBundleFromGithub keeps the total-size limit on the selected folder only", async () => {
  const archive = new JSZip();
  // Outside the selection and larger than the whole 5,000-byte budget. It must
  // not count against the selected folder.
  archive.file(`${ZIPBALL_ROOT}/docs/unrelated.txt`, "U".repeat(20_000));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/a.txt`, "a".repeat(3_000));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/b.txt`, "b".repeat(3_000));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  expect(archiveBuffer.byteLength).toBeLessThan(5_000);

  const config = { ARTIFACT_MAX_UPLOAD_BYTES: 5_000 };
  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill", config }))
    .rejects.toThrow(/references\/b\.txt expands past the \d+-byte limit|exceeds the maximum uncompressed size/);

  // The same budget accepts the selected folder when it fits.
  const fitting = new JSZip();
  fitting.file(`${ZIPBALL_ROOT}/docs/unrelated.txt`, "U".repeat(20_000));
  fitting.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  fitting.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/a.txt`, "a".repeat(3_000));
  const fittingBuffer = await fitting.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await expect(importZipball(fittingBuffer, { subdirectory: "skills/demo-skill", config }))
    .resolves.toBeDefined();
});

test("importSkillBundleFromGithub bounds the inflate of a selected entry that lies about its size", async () => {
  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/references/bomb.txt`, "A".repeat(12 * 1024 * 1024));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  rewriteDeclaredSize(archiveBuffer, `${ZIPBALL_ROOT}/skills/demo-skill/references/bomb.txt`, 64);

  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill" }))
    .rejects.toThrow(/references\/bomb\.txt expands past the 10485760-byte limit/);
}, 30_000);

test("importSkillBundleFromGithub finds the only SKILL.md folder among unrelated files", async () => {
  const archive = new JSZip();
  addUnrelatedFiles(archive, "docs", 80);
  // Hidden folders do not hold candidate skills, as before.
  archive.file(`${ZIPBALL_ROOT}/.github/skill-template/SKILL.md`, skillMarkdown("skill-template"));
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };
  const imported = await importZipball(archiveBuffer, { recorder });

  expect(imported.skill.skillId).toBe("demo-skill");
  expect(recordedFilePaths(recorder)).toEqual(["SKILL.md"]);
});

test("importSkillBundleFromGithub reports a missing or ambiguous SKILL.md in a large repository", async () => {
  const missing = new JSZip();
  addUnrelatedFiles(missing, "docs", 80);
  const missingBuffer = await missing.generateAsync({ type: "nodebuffer" });

  await expect(importZipball(missingBuffer))
    .rejects.toThrow(/exactly one skill bundle root with SKILL\.md/);

  const ambiguous = new JSZip();
  addUnrelatedFiles(ambiguous, "docs", 80);
  ambiguous.file(`${ZIPBALL_ROOT}/skills/first-skill/SKILL.md`, skillMarkdown("first-skill"));
  ambiguous.file(`${ZIPBALL_ROOT}/skills/second-skill/SKILL.md`, skillMarkdown("second-skill"));
  const ambiguousBuffer = await ambiguous.generateAsync({ type: "nodebuffer" });

  await expect(importZipball(ambiguousBuffer))
    .rejects.toThrow(/exactly one skill bundle root with SKILL\.md/);
});

test("importSkillBundleFromGithub rejects malformed archive bytes as AdminConfigError", async () => {
  const result = importZipball(Buffer.from("this is definitely not a zip archive"));
  await expect(result).rejects.toThrow(AdminConfigError);
  await expect(result).rejects.toThrow(/not a valid zip archive/);
});

test("importSkillBundleFromGithub rejects a repository archive above the entry limit before parsing it", async () => {
  expect(MAX_GITHUB_ARCHIVE_ENTRIES).toBeGreaterThan(MAX_SKILL_BUNDLE_FILES);

  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  for (let i = 0; i < MAX_GITHUB_ARCHIVE_ENTRIES; i += 1) {
    archive.file(`${ZIPBALL_ROOT}/f${i}`, "", { createFolders: false });
  }
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  const loadAsync = vi.spyOn(JSZip, "loadAsync");
  onTestFinished(() => loadAsync.mockRestore());

  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill" }))
    .rejects.toThrow(new RegExp(`more than ${MAX_GITHUB_ARCHIVE_ENTRIES} entries`));
  expect(loadAsync).not.toHaveBeenCalled();
}, 30_000);

test("importSkillBundleFromGithub rejects an unsafe entry path outside the selected folder", async () => {
  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  // JSZip strips a leading slash when a file is added, so rename the entry in
  // its internal map (as the zip-slip test above does).
  archive.file(`${ZIPBALL_ROOT}/placeholder.txt`, "pwned");
  const malicious = archive.files[`${ZIPBALL_ROOT}/placeholder.txt`]!;
  malicious.name = "/evil.txt";
  archive.files["/evil.txt"] = malicious;
  delete archive.files[`${ZIPBALL_ROOT}/placeholder.txt`];
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });

  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill" }))
    .rejects.toThrow(/Unsafe zip entry path: \/evil\.txt/);
});

test("importSkillBundleFromGithub matches the subdirectory by whole path segments", async () => {
  const archive = new JSZip();
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("demo-skill"));
  // A sibling whose name starts with the selected name. Its files must not be
  // counted or inflated.
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill-extra/SKILL.md`, skillMarkdown("demo-skill-extra"));
  for (let i = 0; i < 60; i += 1) {
    archive.file(`${ZIPBALL_ROOT}/skills/demo-skill-extra/references/file-${i}.md`, `extra ${i}`);
  }
  archive.file(`${ZIPBALL_ROOT}/skills/demo-skill-extra/references/corrupt.md`, "corrupt me\n".repeat(20));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  corruptDeflateData(archiveBuffer, `${ZIPBALL_ROOT}/skills/demo-skill-extra/references/corrupt.md`);

  const recorder = { calls: [] as RecordedImportInput[], storageUris: [] as Array<string | null> };
  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo-skill", recorder }))
    .resolves.toBeDefined();
  expect(recordedFilePaths(recorder)).toEqual(["SKILL.md"]);

  // A name prefix that is not a whole folder name does not select anything.
  await expect(importZipball(archiveBuffer, { subdirectory: "skills/demo" }))
    .rejects.toThrow(/GitHub subdirectory "skills\/demo" does not exist in the repository archive/);
});

test("importSkillBundleFromGithub removes its temporary folder when an import fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-cleanup-"));
  const isolatedTmp = path.join(root, "tmp");
  await mkdir(isolatedTmp);
  const previousTmpdir = process.env.TMPDIR;
  onTestFinished(async () => {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await rm(root, { recursive: true, force: true });
  });

  // Fails while it extracts the selected folder (file-count limit).
  const tooMany = new JSZip();
  tooMany.file(`${ZIPBALL_ROOT}/skills/big-skill/SKILL.md`, skillMarkdown("big-skill"));
  for (let i = 0; i < 50; i += 1) {
    tooMany.file(`${ZIPBALL_ROOT}/skills/big-skill/references/file-${i}.txt`, `content ${i}`);
  }
  const tooManyBuffer = await tooMany.generateAsync({ type: "nodebuffer" });

  // Fails after extraction, in bundle validation (name mismatch).
  const invalid = new JSZip();
  invalid.file(`${ZIPBALL_ROOT}/skills/demo-skill/SKILL.md`, skillMarkdown("other-name"));
  const invalidBuffer = await invalid.generateAsync({ type: "nodebuffer" });

  const storageRoot = path.join(root, "cache");
  process.env.TMPDIR = isolatedTmp;
  expect(os.tmpdir()).toBe(isolatedTmp);

  for (const archiveBuffer of [tooManyBuffer, invalidBuffer]) {
    await expect(importSkillBundleFromGithub({
      tenantId: "test-tenant",
      config: createTestConfig({ SKILL_BUNDLE_STORAGE_ROOT: storageRoot }),
      skillRevisions: buildFakeSkillRevisions(),
      skillBundleStorage: new LocalSkillBundleStorage(storageRoot),
      githubUrl: "https://github.com/owner/repo",
      ref: "main",
      subdirectory: archiveBuffer === tooManyBuffer ? "skills/big-skill" : "skills/demo-skill",
      actorUserId: "admin-user",
      fetchFn: zipballFetch(archiveBuffer)
    })).rejects.toThrow(AdminConfigError);
  }

  expect(await readdir(isolatedTmp)).toEqual([]);
});
