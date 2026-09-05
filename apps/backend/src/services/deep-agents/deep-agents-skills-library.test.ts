import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompositeBackend } from "deepagents";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SKILLS_LIBRARY_PREFIX,
  buildSkillsLibraryFiles,
  createSkillsLibraryBackend,
  slugifySkillName
} from "./deep-agents-skills-library.js";
import type { RuntimeSkillDefinition } from "../admin-config-records.js";

const fakeLog = createSilentLogger();

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

      // The oversized companion is absent; SKILL.md and the small companion remain.
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
