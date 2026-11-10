import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompositeBackend } from "deepagents";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

// Records the files and directories that the library reads, to count read work.
const fsReads = vi.hoisted(() => ({ files: [] as string[], dirs: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((file: string, ...rest: unknown[]) => {
      fsReads.files.push(String(file));
      return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.readFile,
    readdir: ((dir: string, ...rest: unknown[]) => {
      fsReads.dirs.push(String(dir));
      return (actual.readdir as (...args: unknown[]) => unknown)(dir, ...rest);
    }) as typeof actual.readdir
  };
});

import {
  SKILLS_LIBRARY_PREFIX,
  SkillCompanionCache,
  buildSkillsLibraryFiles,
  createSkillsLibraryBackend,
  slugifySkillName
} from "./deep-agents-skills-library.js";
import type { RuntimeSkillDefinition } from "../admin-config-records.js";

const fakeLog = createSilentLogger();

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47];

/** Writes a bundle directory that the test removes when it finishes. */
async function makeBundleDir(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
    await writeFile(path.join(dir, relativePath), content);
  }
  return dir;
}

/** Storage stand-in that maps each storage URI to a local bundle directory. */
function fakeStorage(localPaths: Record<string, string>) {
  return {
    materializeBundle: vi.fn(async (storageUri: string) => {
      const localPath = localPaths[storageUri];
      if (!localPath) throw new Error(`No bundle at ${storageUri}`);
      return { localPath };
    })
  };
}

/** Counts the file and directory reads under a bundle directory. */
function readsUnder(dir: string): { files: number; dirs: number } {
  const inside = (candidate: string) => candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
  return { files: fsReads.files.filter(inside).length, dirs: fsReads.dirs.filter(inside).length };
}

function makeSkill(overrides: Partial<RuntimeSkillDefinition> = {}): RuntimeSkillDefinition {
  return {
    id: "write-artifact",
    name: "write-artifact",
    description: "Persist generated files",
    instructions: "Call the write_artifact tool for every generated file.",
    version: 1,
    hash: "h",
    revisionId: null,
    bundleHash: null,
    sourceType: "inline",
    bundleName: null,
    bundleStorageUri: null,
    validationStatus: null,
    reviewStatus: null,
    ...overrides
  };
}

describe("slugifySkillName", () => {
  it("lowercases, hyphenates, and trims per the Agent Skills spec", () => {
    expect(slugifySkillName("Write Artifact", "fb")).toBe("write-artifact");
    expect(slugifySkillName("  __Data / Analysis!! ", "fb")).toBe("data-analysis");
    expect(slugifySkillName("already-fine", "fb")).toBe("already-fine");
  });

  it("falls back when nothing survives slugification", () => {
    expect(slugifySkillName("!!!", "skill-x")).toBe("skill-x");
  });

  it("caps length at 64 without a trailing hyphen", () => {
    const slug = slugifySkillName(`${"a".repeat(63)} tail`, "fb");
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("buildSkillsLibraryFiles", () => {
  it("generates a SKILL.md with spec-compliant frontmatter from the compiled definition", async () => {
    const files = await buildSkillsLibraryFiles({ skills: [makeSkill()], logger: fakeLog });

    const skillMd = files["/write-artifact/SKILL.md"];
    expect(skillMd).toBeTruthy();
    const content = skillMd!.content as string;
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain('name: "write-artifact"');
    expect(content).toContain('description: "Persist generated files"');
    expect(content).toContain("Call the write_artifact tool for every generated file.");
    expect(skillMd!.mimeType).toBe("text/markdown");
  });

  it("slugifies non-compliant names so frontmatter name matches the directory", async () => {
    const files = await buildSkillsLibraryFiles({
      skills: [makeSkill({ id: "s1", name: "Write Artifact" })],
      logger: fakeLog
    });
    const content = files["/write-artifact/SKILL.md"]!.content as string;
    expect(content).toContain('name: "write-artifact"');
    expect(content).toContain('displayName: "Write Artifact"');
  });

  it("dedupes colliding slugs and skips skills without instructions", async () => {
    const files = await buildSkillsLibraryFiles({
      skills: [
        makeSkill({ id: "s1", name: "My Skill" }),
        makeSkill({ id: "s2", name: "my-skill" }),
        makeSkill({ id: "s3", name: "empty", instructions: "   " })
      ],
      logger: fakeLog
    });
    expect(Object.keys(files).sort()).toEqual(["/my-skill-2/SKILL.md", "/my-skill/SKILL.md"]);
  });

  describe("bundle companions", () => {
    let bundleDir: string;

    afterEach(async () => {
      await rm(bundleDir, { recursive: true, force: true });
    });

    it("materializes companion files (nested + binary), skipping the bundle's own SKILL.md", async () => {
      bundleDir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-"));
      await writeFile(path.join(bundleDir, "SKILL.md"), "---\nstale: true\n---\noriginal");
      await writeFile(path.join(bundleDir, "helper.py"), "print('hi')\n");
      await mkdir(path.join(bundleDir, "data"));
      await writeFile(path.join(bundleDir, "data", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const materializeBundle = vi.fn(async () => ({ localPath: bundleDir }));
      const files = await buildSkillsLibraryFiles({
        skills: [makeSkill({ bundleStorageUri: "file:///whatever" })],
        bundles: { materializeBundle },
        logger: fakeLog
      });

      expect(materializeBundle).toHaveBeenCalledWith("file:///whatever");
      // Generated SKILL.md wins over the bundle's copy (revision metadata is
      // the source of truth).
      expect(files["/write-artifact/SKILL.md"]!.content).toContain("write_artifact tool");
      expect(files["/write-artifact/SKILL.md"]!.content).not.toContain("original");
      expect(files["/write-artifact/helper.py"]).toMatchObject({ mimeType: "text/x-python" });
      expect(files["/write-artifact/helper.py"]!.content).toBe("print('hi')\n");
      const logo = files["/write-artifact/data/logo.png"]!;
      expect(logo.mimeType).toBe("image/png");
      expect(logo.content).toBeInstanceOf(Uint8Array);
      expect([...(logo.content as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it("excludes an external-file symlink while serving a regular companion", async () => {
      bundleDir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-"));
      const root = path.join(bundleDir, "bundle");
      await mkdir(root);
      await writeFile(path.join(bundleDir, "private.txt"), "private content");
      await writeFile(path.join(root, "notes.txt"), "allowed content");
      await symlink(path.join(bundleDir, "private.txt"), path.join(root, "linked.txt"));
      const files = await buildSkillsLibraryFiles({
        skills: [makeSkill({ bundleStorageUri: "file:///fixture" })],
        bundles: { materializeBundle: async () => ({ localPath: root }) },
        logger: fakeLog
      });
      expect(Object.keys(files).sort()).toEqual([
        "/write-artifact/SKILL.md", "/write-artifact/notes.txt"
      ]);
      expect(files["/write-artifact/notes.txt"]?.content).toBe("allowed content");
    });

    it("skips a companion over the 10MB cap while keeping SKILL.md and small companions", async () => {
      // Companion files over MAX_COMPANION_FILE_BYTES (10MB) are dropped with a
      // warning so a giant asset can't balloon the in-memory /skills/ backend.
      // A dropped cap would materialize the oversized file into memory.
      bundleDir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-"));
      await writeFile(path.join(bundleDir, "small.txt"), "ok\n");
      // 1 byte over the cap.
      await writeFile(path.join(bundleDir, "huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1, 0));

      const files = await buildSkillsLibraryFiles({
        skills: [makeSkill({ bundleStorageUri: "file:///whatever" })],
        bundles: { materializeBundle: vi.fn(async () => ({ localPath: bundleDir })) },
        logger: fakeLog
      });

      expect(files["/write-artifact/huge.bin"]).toBeUndefined();
      expect(files["/write-artifact/SKILL.md"]).toBeDefined();
      expect(files["/write-artifact/small.txt"]!.content).toBe("ok\n");
    });

    it("degrades to SKILL.md-only when the bundle fails to materialize", async () => {
      bundleDir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-"));
      const files = await buildSkillsLibraryFiles({
        skills: [makeSkill({ bundleStorageUri: "s3://missing/bundle" })],
        bundles: {
          materializeBundle: vi.fn(async () => {
            throw new Error("bucket unreachable");
          })
        },
        logger: fakeLog
      });
      expect(Object.keys(files)).toEqual(["/write-artifact/SKILL.md"]);
    });
  });
});

describe("companion cache", () => {
  const URI_A = "file:///var/skills/tenant-a/write-artifact/hash-a";
  const URI_B = "file:///var/skills/tenant-b/write-artifact/hash-a";

  it("reads each bundle once for repeated and concurrent session builds", async () => {
    const dir = await makeBundleDir({
      "references/guide.md": "# Guide\n",
      "assets/logo.png": new Uint8Array(PNG_BYTES)
    });
    const bundles = fakeStorage({ [URI_A]: dir });
    const skills = [makeSkill({ bundleStorageUri: URI_A })];

    const concurrent = await Promise.all([
      buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog }),
      buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog })
    ]);
    const later = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });

    // One load: two files, and three directories (root, assets, references).
    expect(readsUnder(dir)).toEqual({ files: 2, dirs: 3 });
    // Each build still resolves the bundle, so a deleted bundle stops serving.
    expect(bundles.materializeBundle).toHaveBeenCalledTimes(3);
    for (const files of [...concurrent, later]) {
      expect(files["/write-artifact/references/guide.md"]!.content).toBe("# Guide\n");
      expect([...(files["/write-artifact/assets/logo.png"]!.content as Uint8Array)]).toEqual(PNG_BYTES);
    }
  });

  it("shares the binary bytes between sessions, not a copy for each session", async () => {
    const dir = await makeBundleDir({ "assets/logo.png": new Uint8Array(PNG_BYTES) });
    const bundles = fakeStorage({ [URI_A]: dir });
    const skills = [makeSkill({ bundleStorageUri: URI_A })];

    const first = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });
    const second = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });

    const firstLogo = first["/write-artifact/assets/logo.png"]!;
    const secondLogo = second["/write-artifact/assets/logo.png"]!;
    expect(secondLogo.content).toBe(firstLogo.content);
    expect((secondLogo.content as Uint8Array).buffer).toBe((firstLogo.content as Uint8Array).buffer);
    // The bytes own an exactly sized buffer, so the cache holds no extra bytes.
    expect((secondLogo.content as Uint8Array).buffer.byteLength).toBe(PNG_BYTES.length);
    // Each build gets its own file records; only the content is shared.
    expect(secondLogo).not.toBe(firstLogo);
  });

  it("keeps bundles apart by storage URI and by storage backend", async () => {
    const tenantA = await makeBundleDir({ "notes.txt": "tenant a" });
    const tenantB = await makeBundleDir({ "notes.txt": "tenant b" });
    const otherRoot = await makeBundleDir({ "notes.txt": "other storage" });
    const skills = (uri: string) => [makeSkill({ bundleStorageUri: uri })];
    const storage = fakeStorage({ [URI_A]: tenantA, [URI_B]: tenantB });
    // A second backend that holds a different bundle under the same URI.
    const otherStorage = fakeStorage({ [URI_A]: otherRoot });

    const a = await buildSkillsLibraryFiles({ skills: skills(URI_A), bundles: storage, logger: fakeLog });
    const b = await buildSkillsLibraryFiles({ skills: skills(URI_B), bundles: storage, logger: fakeLog });
    const other = await buildSkillsLibraryFiles({ skills: skills(URI_A), bundles: otherStorage, logger: fakeLog });

    expect(a["/write-artifact/notes.txt"]!.content).toBe("tenant a");
    expect(b["/write-artifact/notes.txt"]!.content).toBe("tenant b");
    expect(other["/write-artifact/notes.txt"]!.content).toBe("other storage");
  });

  it("serves the new bundle when a new revision changes the storage URI", async () => {
    const revision1 = await makeBundleDir({ "notes.txt": "revision 1" });
    const revision2 = await makeBundleDir({ "notes.txt": "revision 2" });
    const uri2 = "file:///var/skills/tenant-a/write-artifact/hash-b";
    const bundles = fakeStorage({ [URI_A]: revision1, [uri2]: revision2 });

    const before = await buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: URI_A })], bundles, logger: fakeLog
    });
    const after = await buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: uri2, version: 2 })], bundles, logger: fakeLog
    });

    expect(before["/write-artifact/notes.txt"]!.content).toBe("revision 1");
    expect(after["/write-artifact/notes.txt"]!.content).toBe("revision 2");
  });

  it("generates SKILL.md from the current instructions when the companions come from the cache", async () => {
    const dir = await makeBundleDir({ "notes.txt": "companion" });
    const bundles = fakeStorage({ [URI_A]: dir });

    const first = await buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: URI_A, instructions: "Old instructions." })], bundles, logger: fakeLog
    });
    const second = await buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: URI_A, name: "Renamed", instructions: "New instructions." })],
      bundles,
      logger: fakeLog
    });

    expect(first["/write-artifact/SKILL.md"]!.content).toContain("Old instructions.");
    expect(second["/renamed/SKILL.md"]!.content).toContain("New instructions.");
    expect(second["/renamed/SKILL.md"]!.content).not.toContain("Old instructions.");
    // The cached companion moves to the new slug without a second read.
    expect(second["/renamed/notes.txt"]!.content).toBe("companion");
    expect(readsUnder(dir).files).toBe(1);
  });

  it("tries the load again after a failed companion load", async () => {
    const parent = await makeBundleDir({});
    const dir = path.join(parent, "bundle");
    const bundles = fakeStorage({ [URI_A]: dir });
    const skills = [makeSkill({ bundleStorageUri: URI_A })];

    // The directory does not exist yet, so the companion load fails.
    const failed = await Promise.all([
      buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog }),
      buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog })
    ]);
    await mkdir(dir);
    await writeFile(path.join(dir, "notes.txt"), "recovered");
    const recovered = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });

    for (const files of failed) expect(Object.keys(files)).toEqual(["/write-artifact/SKILL.md"]);
    expect(recovered["/write-artifact/notes.txt"]!.content).toBe("recovered");
  });

  it("stops serving cached companions when the bundle is no longer in storage", async () => {
    const dir = await makeBundleDir({ "notes.txt": "cached" });
    const bundles = fakeStorage({ [URI_A]: dir });
    const skills = [makeSkill({ bundleStorageUri: URI_A })];
    await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });

    bundles.materializeBundle.mockRejectedValueOnce(new Error("Skill bundle not found on disk"));
    const files = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });

    expect(Object.keys(files)).toEqual(["/write-artifact/SKILL.md"]);
  });

  it("evicts the least recently used bundle when the entry limit is reached", async () => {
    const companionCache = new SkillCompanionCache({ maxBytes: 1024, maxEntries: 2 });
    const uris = ["file:///b/one", "file:///b/two", "file:///b/three"];
    const dirs = await Promise.all(uris.map((uri) => makeBundleDir({ "notes.txt": uri })));
    const bundles = fakeStorage(Object.fromEntries(uris.map((uri, index) => [uri, dirs[index]!])));
    const build = (index: number) => buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: uris[index]! })], bundles, logger: fakeLog, companionCache
    });

    await build(0);
    await build(1);
    await build(0); // Use "one" again, so "two" is now the least recently used.
    await build(2); // Evicts "two".
    expect(companionCache.stats()).toEqual({
      entries: 2, bytes: "file:///b/one".length + "file:///b/three".length
    });

    await build(0);
    await build(2);
    expect(dirs.map((dir) => readsUnder(dir).files)).toEqual([1, 1, 1]);
    const reloaded = await build(1);
    expect(reloaded["/write-artifact/notes.txt"]!.content).toBe("file:///b/two");
    expect(readsUnder(dirs[1]!).files).toBe(2);
    expect(companionCache.stats().entries).toBe(2);
  });

  it("keeps the cached bytes under the byte limit and does not keep a bundle that is too large", async () => {
    const companionCache = new SkillCompanionCache({ maxBytes: 10, maxEntries: 10 });
    const small1 = await makeBundleDir({ "a.txt": "123456" });
    const small2 = await makeBundleDir({ "b.txt": "abcdef" });
    const large = await makeBundleDir({ "c.txt": "0123456789X" });
    const bundles = fakeStorage({ "file:///s1": small1, "file:///s2": small2, "file:///large": large });
    const build = (uri: string) => buildSkillsLibraryFiles({
      skills: [makeSkill({ bundleStorageUri: uri })], bundles, logger: fakeLog, companionCache
    });

    await build("file:///s1");
    await build("file:///s2"); // 12 bytes in total: evicts s1.
    expect(companionCache.stats()).toEqual({ entries: 1, bytes: 6 });

    const first = await build("file:///large");
    const second = await build("file:///large");
    expect(first["/write-artifact/c.txt"]!.content).toBe("0123456789X");
    expect(second["/write-artifact/c.txt"]!.content).toBe("0123456789X");
    // The large bundle is served on each build but never kept.
    expect(readsUnder(large).files).toBe(2);
    expect(companionCache.stats()).toEqual({ entries: 1, bytes: 6 });
  });
});

describe("createSkillsLibraryBackend", () => {
  async function makeBackend() {
    const files = await buildSkillsLibraryFiles({ skills: [makeSkill()], logger: fakeLog });
    return createSkillsLibraryBackend(files);
  }

  it("serves ls/read/grep and rejects mutations", async () => {
    const backend = await makeBackend();

    const ls = await backend.ls("/");
    expect(ls.files?.map((f) => f.path)).toContain("/write-artifact/");

    const read = await backend.read("/write-artifact/SKILL.md");
    expect(read.error).toBeUndefined();
    expect(read.content).toContain("write_artifact");

    const grep = await backend.grep("write_artifact", "/", null);
    expect(grep.matches?.length).toBeGreaterThan(0);

    expect((await backend.write("/write-artifact/SKILL.md", "x")).error).toMatch(/read-only/);
    expect((await backend.edit("/write-artifact/SKILL.md", "a", "b", false)).error).toMatch(
      /read-only/
    );
    const uploads = await backend.uploadFiles!([["/x.txt", new Uint8Array([1])]]);
    expect(uploads[0]).toEqual({ path: "/x.txt", error: "permission_denied" });
  });

  it("returns copies of binary content, so a caller cannot change the shared bytes", async () => {
    const dir = await makeBundleDir({ "assets/logo.png": new Uint8Array(PNG_BYTES) });
    const bundles = fakeStorage({ "file:///bundle": dir });
    const skills = [makeSkill({ bundleStorageUri: "file:///bundle" })];
    const files = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });
    const backend = createSkillsLibraryBackend(files);
    const logoPath = "/write-artifact/assets/logo.png";

    const read = await backend.read(logoPath);
    const raw = await backend.readRaw(logoPath);
    const [download] = await backend.downloadFiles!([logoPath]);
    expect(read.mimeType).toBe("image/png");
    expect(raw.data).toMatchObject({ mimeType: "image/png" });
    expect(download?.error).toBeNull();
    for (const content of [read.content, raw.data?.content, download?.content]) {
      expect([...(content as Uint8Array)]).toEqual(PNG_BYTES);
      (content as Uint8Array).fill(0);
    }

    const nextSession = await buildSkillsLibraryFiles({ skills, bundles, logger: fakeLog });
    expect([...(files[logoPath]!.content as Uint8Array)]).toEqual(PNG_BYTES);
    expect([...(nextSession[logoPath]!.content as Uint8Array)]).toEqual(PNG_BYTES);
    expect((await backend.ls("/write-artifact/assets")).files?.[0]?.size).toBe(PNG_BYTES.length);
  });

  it("round-trips through a CompositeBackend /skills/ route (the graph's wiring)", async () => {
    // Pins the interplay the skills middleware depends on: the composite
    // strips the /skills/ prefix before delegating and re-adds it on listing
    // results, so the SKILL.md paths shown to the model resolve via read.
    const skillsBackend = await makeBackend();
    const defaultBackend = createSkillsLibraryBackend({}); // empty stand-in default
    const composite = new CompositeBackend(defaultBackend, {
      [SKILLS_LIBRARY_PREFIX]: skillsBackend
    });

    const rootLs = await composite.ls("/");
    expect(rootLs.files?.map((f) => f.path)).toContain(SKILLS_LIBRARY_PREFIX);

    const skillsLs = await composite.ls(SKILLS_LIBRARY_PREFIX);
    expect(skillsLs.files?.map((f) => f.path)).toContain("/skills/write-artifact/");

    const read = await composite.read("/skills/write-artifact/SKILL.md");
    expect(read.error).toBeUndefined();
    expect(read.content).toContain("write_artifact");

    expect((await composite.write("/skills/notes.txt", "x")).error).toMatch(/read-only/);
  });
});
