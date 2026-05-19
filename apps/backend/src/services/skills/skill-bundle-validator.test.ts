import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import { MAX_SKILL_BUNDLE_FILE_BYTES, MAX_SKILL_BUNDLE_FILES } from "./skill-bundle-limits.js";
import { validateSkillBundle } from "./skill-bundle-validator.js";

test("validateSkillBundle parses a valid AgentSkills bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-"));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(path.join(bundlePath, "references"), { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    `---
name: pdf-processing
description: Extract text and fill PDF forms. Use when working with PDFs.
license: Apache-2.0
compatibility: Requires pdftotext
allowed-tools: Bash(git:*) Read
metadata:
  author: cogniplane
---

Open the PDF, inspect the references, and preserve form field names.
`
  );
  await writeFile(path.join(bundlePath, "references", "REFERENCE.md"), "Reference details");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const result = await validateSkillBundle(bundlePath);

  expect(result.messages.length).toBe(0);
  expect(result.bundle).toBeTruthy();
  expect(result.bundle?.bundleName).toBe("pdf-processing");
  expect(result.bundle?.allowedTools[0]).toBe("Bash(git:*)");
  expect(result.bundle?.metadata.author).toBe("cogniplane");
  expect(result.bundle?.files.length).toBe(2);
  expect(result.bundle?.contentHash ?? "").toMatch(/^[a-f0-9]{64}$/);
});

test("validateSkillBundle rejects invalid frontmatter and missing SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-invalid-"));
  const invalidNamePath = path.join(root, "Invalid_Skill");
  await mkdir(invalidNamePath, { recursive: true });
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const invalidNameResult = await validateSkillBundle(invalidNamePath);
  expect(invalidNameResult.bundle).toBe(null);
  expect(invalidNameResult.messages[0]?.message ?? "").toMatch(/Bundle directory name/);

  const bundlePath = path.join(root, "missing-frontmatter");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(path.join(bundlePath, "SKILL.md"), "# Missing frontmatter");

  const missingFrontmatterResult = await validateSkillBundle(bundlePath);
  expect(missingFrontmatterResult.bundle).toBe(null);
  expect(missingFrontmatterResult.messages.some((entry) =>
          entry.message.includes("YAML frontmatter")
        )).toBeTruthy();
});

test("validateSkillBundle rejects unsupported top-level entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-layout-"));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(path.join(bundlePath, "examples"), { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse the bundle.\n"
  );
  await writeFile(path.join(bundlePath, "stray.txt"), "not allowed at root");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const result = await validateSkillBundle(bundlePath);

  expect(result.bundle).toBe(null);
  expect(result.messages.some((entry) => entry.path === "examples")).toBeTruthy();
  expect(result.messages.some((entry) => entry.path === "stray.txt")).toBeTruthy();
});

test("validateSkillBundle accepts README.md and LICENSE at the skill root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-readme-"));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse the bundle.\n"
  );
  await writeFile(path.join(bundlePath, "README.md"), "# PDF processing\n");
  await writeFile(path.join(bundlePath, "LICENSE"), "MIT\n");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const result = await validateSkillBundle(bundlePath);

  expect(result.messages.length).toBe(0);
  expect(result.bundle).toBeTruthy();
  expect(result.bundle?.files.length).toBe(3);
});

test("validateSkillBundle rejects bundles with too many files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-file-count-"));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(path.join(bundlePath, "references"), { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse the bundle.\n"
  );
  for (let i = 0; i < MAX_SKILL_BUNDLE_FILES; i += 1) {
    await writeFile(path.join(bundlePath, "references", `${i}.md`), "reference");
  }
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const result = await validateSkillBundle(bundlePath);

  expect(result.bundle).toBe(null);
  expect(result.messages.some((entry) =>
          entry.message.includes(`at most ${MAX_SKILL_BUNDLE_FILES} files`)
        )).toBeTruthy();
});

test("validateSkillBundle rejects oversized files before reading them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-validator-file-size-"));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(path.join(bundlePath, "references"), { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Process PDFs\n---\nUse the bundle.\n"
  );
  await writeFile(path.join(bundlePath, "references", "large.md"), Buffer.alloc(MAX_SKILL_BUNDLE_FILE_BYTES + 1));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const result = await validateSkillBundle(bundlePath);

  expect(result.bundle).toBe(null);
  expect(result.messages.some((entry) =>
          entry.path === "references/large.md" && entry.message.includes("maximum size")
        )).toBeTruthy();
});

async function makeBundle(dirSuffix: string, skillContent: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `cogniplane-skill-validator-${dirSuffix}-`));
  const bundlePath = path.join(root, "pdf-processing");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(path.join(bundlePath, "SKILL.md"), skillContent);
  return { root, bundlePath };
}

test("validateSkillBundle rejects SKILL.md without YAML frontmatter delimiters", async () => {
  const { root, bundlePath } = await makeBundle(
    "no-fm",
    "Just a body, no frontmatter at all.\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("YAML frontmatter delimited by ---"))
  ).toBe(true);
});

test("validateSkillBundle rejects malformed YAML inside the frontmatter", async () => {
  const { root, bundlePath } = await makeBundle(
    "bad-yaml",
    "---\nname: pdf-processing\ndescription: \"unterminated\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(result.messages.some((m) => m.message.startsWith("Invalid YAML frontmatter"))).toBe(true);
});

test("validateSkillBundle rejects when frontmatter is a list (not a mapping)", async () => {
  const { root, bundlePath } = await makeBundle(
    "list-fm",
    "---\n- alpha\n- beta\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("Skill frontmatter must be a key-value mapping"))
  ).toBe(true);
});

test("validateSkillBundle rejects bundle directory names with uppercase or symbols", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-bad-bundle-name-"));
  const bundlePath = path.join(root, "Bad_Name");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    "---\nname: bad-name\ndescription: ok\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("Bundle directory name must be"))
  ).toBe(true);
});

test("validateSkillBundle rejects metadata that is not a key-value mapping", async () => {
  const { root, bundlePath } = await makeBundle(
    "bad-metadata",
    "---\nname: pdf-processing\ndescription: ok\nmetadata:\n  - 1\n  - 2\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) =>
      m.message.includes("Frontmatter metadata must be a mapping of string keys to string values")
    )
  ).toBe(true);
});

test("validateSkillBundle rejects metadata values that are not strings", async () => {
  const { root, bundlePath } = await makeBundle(
    "metadata-non-string",
    "---\nname: pdf-processing\ndescription: ok\nmetadata:\n  count: 5\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(result.messages.some((m) => m.message.includes("Metadata value for count must be a string"))).toBe(true);
});

test("validateSkillBundle rejects an empty frontmatter description", async () => {
  const { root, bundlePath } = await makeBundle(
    "empty-desc",
    "---\nname: pdf-processing\ndescription: ' '\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("Frontmatter must include a non-empty description"))
  ).toBe(true);
});

test("validateSkillBundle rejects a frontmatter description longer than 1024 characters", async () => {
  const { root, bundlePath } = await makeBundle(
    "long-desc",
    `---\nname: pdf-processing\ndescription: ${"x".repeat(1025)}\n---\nbody\n`
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("description must be 1024 characters or fewer"))
  ).toBe(true);
});

test("validateSkillBundle rejects a compatibility string longer than 500 characters", async () => {
  const { root, bundlePath } = await makeBundle(
    "long-compat",
    `---\nname: pdf-processing\ndescription: ok\ncompatibility: ${"x".repeat(501)}\n---\nbody\n`
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(result.messages.some((m) => m.message.includes("Compatibility must be 500 characters or fewer"))).toBe(true);
});

test("validateSkillBundle rejects an empty frontmatter name", async () => {
  const { root, bundlePath } = await makeBundle(
    "empty-name",
    "---\nname: ' '\ndescription: ok\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(result.messages.some((m) => m.message.includes("Frontmatter must include a non-empty name"))).toBe(true);
});

test("validateSkillBundle rejects a frontmatter name with invalid characters", async () => {
  const { root, bundlePath } = await makeBundle(
    "bad-name-chars",
    "---\nname: 'Bad_Name'\ndescription: ok\n---\nbody\n"
  );
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

  const result = await validateSkillBundle(bundlePath);
  expect(result.bundle).toBeNull();
  expect(
    result.messages.some((m) => m.message.includes("Frontmatter name must be"))
  ).toBe(true);
});
