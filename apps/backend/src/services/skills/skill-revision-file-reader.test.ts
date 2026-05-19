import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";

import type { AdminSkillRevisionRecord } from "../admin-config-records.js";

import { readSkillRevisionFile, SKILL_FILE_PREVIEW_LIMIT_BYTES } from "./skill-revision-file-reader.js";

function revision(overrides: Partial<AdminSkillRevisionRecord> = {}): AdminSkillRevisionRecord {
  return {
    skillRevisionId: 1,
    skillId: "sk1",
    revisionNumber: 1,
    sourceType: "inline",
    sourceLabel: null,
    bundleName: null,
    bundleStorageUri: null,
    bundleHash: "h",
    validationStatus: "valid",
    validationMessages: [],
    reviewStatus: "pending",
    reviewNotes: null,
    metadata: {},
    createdBy: "u",
    createdAt: "now",
    reviewedBy: null,
    reviewedAt: null,
    activatedAt: null,
    ...overrides
  };
}

const stubBundleStorage = {
  async materializeBundle(_uri: string) {
    throw new Error("not used");
  }
};

// ── Inline skill paths (no bundle) ──────────────────────────────────────────

test("inline skill: returns the SKILL.md content from metadata.instructions", async () => {
  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: null,
      metadata: { instructions: "Always do X." }
    }),
    requestedPath: "SKILL.md",
    skillBundleStorage: stubBundleStorage
  });
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.content).toBe("Always do X.");
    expect(result.encoding).toBe("utf8");
    expect(result.contentType).toBe("text/markdown");
  }
});

test("inline skill: returns not_found for any non-SKILL.md path", async () => {
  const result = await readSkillRevisionFile({
    revision: revision({ bundleStorageUri: null, metadata: { instructions: "x" } }),
    requestedPath: "extra.py",
    skillBundleStorage: stubBundleStorage
  });
  expect(result.kind).toBe("not_found");
});

test("inline skill: returns not_found when metadata.instructions is missing", async () => {
  const result = await readSkillRevisionFile({
    revision: revision({ bundleStorageUri: null, metadata: {} }),
    requestedPath: "SKILL.md",
    skillBundleStorage: stubBundleStorage
  });
  expect(result.kind).toBe("not_found");
});

test("inline skill: returns too_large when instructions exceed the byte limit", async () => {
  const huge = "a".repeat(SKILL_FILE_PREVIEW_LIMIT_BYTES + 1);
  const result = await readSkillRevisionFile({
    revision: revision({ bundleStorageUri: null, metadata: { instructions: huge } }),
    requestedPath: "SKILL.md",
    limitBytes: 10,
    skillBundleStorage: stubBundleStorage
  });
  expect(result.kind).toBe("too_large");
  if (result.kind === "too_large") {
    expect(result.limitBytes).toBe(10);
  }
});

// ── Bundle-backed skill paths ───────────────────────────────────────────────

let tmpRoot: string;

test("bundle skill: extracts and reads a manifested file as utf8", async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(tmpRoot, { recursive: true, force: true }));

  await writeFile(path.join(tmpRoot, "SKILL.md"), "# hi", "utf8");
  await mkdir(path.join(tmpRoot, "scripts"), { recursive: true });
  await writeFile(path.join(tmpRoot, "scripts", "tool.py"), "print('hi')\n", "utf8");

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "scripts/tool.py" }] }
    }),
    requestedPath: "scripts/tool.py",
    skillBundleStorage: {
      async materializeBundle() {
        return { localPath: tmpRoot } as never;
      }
    }
  });
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.content).toMatch(/print\('hi'\)/);
    expect(result.contentType).toBe("text/x-python");
    expect(result.encoding).toBe("utf8");
  }
});

test("bundle skill: returns not_found when the requested path is not in the manifest", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "SKILL.md"), "# hi");

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "SKILL.md" }] }
    }),
    requestedPath: "SECRET.md", // not in manifest
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: returns not_found when manifest entries are not objects with path strings", async () => {
  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: ["not-an-object", { other: "x" }, null] }
    }),
    requestedPath: "SKILL.md",
    skillBundleStorage: { async materializeBundle() { throw new Error("won't reach"); } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: refuses path traversal even if the manifest claims it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      // Manifest validation lives elsewhere; here we just confirm the reader
      // refuses paths that resolve outside the bundle root.
      metadata: { files: [{ path: "../etc/passwd" }] }
    }),
    requestedPath: "../etc/passwd",
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: returns not_found when materializeBundle throws", async () => {
  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "SKILL.md" }] }
    }),
    requestedPath: "SKILL.md",
    skillBundleStorage: { async materializeBundle() { throw new Error("download failed"); } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: returns not_found when the file is missing on disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  // Manifest claims SKILL.md exists but it doesn't.

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "SKILL.md" }] }
    }),
    requestedPath: "SKILL.md",
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: returns not_found when the manifested 'file' is actually a directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "is-a-dir"));

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "is-a-dir" }] }
    }),
    requestedPath: "is-a-dir",
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("not_found");
});

test("bundle skill: returns too_large when file exceeds the limit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "big.md"), "a".repeat(2_000));

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "big.md" }] }
    }),
    requestedPath: "big.md",
    limitBytes: 100,
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("too_large");
  if (result.kind === "too_large") {
    expect(result.limitBytes).toBe(100);
    expect(result.sizeBytes).toBe(2_000);
  }
});

test("bundle skill: image file is returned as base64 with image/* contentType", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  // 1x1 PNG
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
  ]);
  await writeFile(path.join(dir, "icon.png"), png);

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "icon.png" }] }
    }),
    requestedPath: "icon.png",
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.encoding).toBe("base64");
    expect(result.contentType).toBe("image/png");
    expect(Buffer.from(result.content, "base64").byteLength).toBe(png.byteLength);
  }
});

test("bundle skill: a binary blob with NUL byte is returned as base64 with octet-stream type", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-reader-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "blob.dat"), Buffer.from([0x01, 0x00, 0x02]));

  const result = await readSkillRevisionFile({
    revision: revision({
      bundleStorageUri: "file:///fake",
      metadata: { files: [{ path: "blob.dat" }] }
    }),
    requestedPath: "blob.dat",
    skillBundleStorage: { async materializeBundle() { return { localPath: dir } as never; } }
  });
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.encoding).toBe("base64");
    expect(result.contentType).toBe("application/octet-stream");
  }
});
