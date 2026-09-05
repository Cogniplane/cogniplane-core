import { Response, type fetch as undiciFetch, type RequestInit } from "undici";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

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
    async importSkillBundle(
      _tenantId: string,
      input: RecordedImportInput
    ): Promise<ImportedSkillBundleRecord> {
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

  // A zip bomb: 20 MB of a single repeated byte, which DEFLATE crushes to a
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

  // The subtlest construction: each entry is padded with incompressible random
  // bytes so its true ratio sits well under the per-entry cap (~60:1), AND
  // every declared size is then rewritten to 64 bytes. Declared total ~2.6 KB,
  // declared worst ratio ~1.7:1 — every size and every ratio check passes —
  // while the archive really inflates to about 32 MB.
  //
  // What refuses it is the per-entry length comparison after inflation, which
  // fires on the first entry. Worth pinning explicitly: it is the check that
  // makes the declared sizes safe to reason about at all, and the one that
  // makes the archive-wide total counter unfoolable downstream of it.
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
  // size caps see a 64-byte file. This is the case the old code let through:
  // it inflated the whole entry and only compared lengths afterwards.
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

  // The lie makes the ratio look SMALL (64 bytes from a few KB compressed), so
  // it slips past the ratio check — and is then caught by the post-inflate
  // length comparison. That inflation is bounded: the ratio check already
  // capped this entry at compressedSize x 100, which is why running it is safe.
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

test("importSkillBundleFromZip accepts a bundle with ordinary text compression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-ratio-ok-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Real prose compresses maybe 3-5x, nowhere near the 100:1 bound. The ratio
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

test("importSkillBundleFromZip bounds ALLOCATION, not just retention, on a lying zip bomb", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-oom-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // The assertion that distinguishes a real fix from a plausible one. Every
  // earlier attempt — trusting the declared size, streaming with a counting
  // cap, a ratio computed from the declared size — also REJECTED this archive,
  // but only after decompressing the whole thing. That reports the OOM instead
  // of preventing it, so "it throws" proves nothing on its own.
  //
  // What is asserted instead: the rejection names the byte limit and the
  // COMPRESSED size it was derived from. Only a check that runs on the
  // compressed bytes can produce that message; every design that inflates
  // first reports a declared-vs-actual mismatch, or jszip's own post-hoc
  // "uncompressed data size mismatch", neither of which matches here.
  //
  // (A heap-delta assertion was tried and removed: it failed about two runs in
  // three from unrelated GC timing. A flaky test is worse than none. The
  // payload is 60 MB rather than the 600 MB used when measuring by hand,
  // because building the archive dominates the runtime and the property does
  // not depend on the size.)
  const archive = new JSZip();
  archive.file(
    "test-skill/SKILL.md",
    "---\nname: test-skill\ndescription: A test skill\n---\n# Instructions\nTest skill instructions.\n"
  );
  archive.file("test-skill/references/bomb.txt", Buffer.alloc(60_000_000, 0x41));
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // Rewrite every declared uncompressed size to 64 bytes, so nothing that
  // reads the header can tell this apart from a trivial file.
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
        originalFileName: "bomb.zip",
        actorUserId: "admin-user"
      })).rejects.toThrow(/expands past the \d+-byte limit allowed for its \d+ compressed bytes/);
  // Generous: building a 60 MB archive dominates the runtime and slows further
  // under coverage instrumentation. The assertion itself is instant.
}, 30_000);

test("importSkillBundleFromZip handles STORE-compressed (uncompressed) entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-store-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Method 0 has no compressed stream to inflate, so `inflateEntryBounded`
  // returns the raw bytes on a separate branch. Archives written by some tools
  // (and any already-compressed file) take it, so it needs its own coverage —
  // driving zlib directly means the two methods no longer share a code path.
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

// --- SSRF redirect-loop coverage -------------------------------------------

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

// --- Archive (zip-slip + file-count) defenses ------------------------------

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
