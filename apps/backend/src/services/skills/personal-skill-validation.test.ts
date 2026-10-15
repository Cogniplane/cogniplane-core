import { expect, test } from "vitest";
import { PersonalSkillValidationError, SkillSourceValidationError, validatePersonalSkillSource, validateSkillSource } from "./personal-skill-validation.js";

test("accepts inline instructions and rejects blank instructions", () => {
  expect(validatePersonalSkillSource({ kind: "inline", name: "write-notes", description: "Write notes", instructions: "Use plain words." }))
    .toEqual({ content: { name: "write-notes", description: "Write notes", instructions: "Use plain words." }, validationMessages: [] });
  expect(() => validatePersonalSkillSource({ kind: "inline", name: "write-notes", description: "Write notes", instructions: "  " }))
    .toThrow(PersonalSkillValidationError);
});

test("parses SKILL.md but warns that tool grants and companion files have no effect", () => {
  const result = validatePersonalSkillSource({ kind: "markdown", markdown: `---\nname: write-notes\ndescription: Write notes\nallowed-tools: Bash\nmetadata:\n  owner: me\n---\nUse [the guide](references/guide.md).` });
  expect(result.content).toEqual({ name: "write-notes", description: "Write notes", instructions: "Use [the guide](references/guide.md)." });
  expect(result.validationMessages.join(" ")).toMatch(/allowed-tools.*ignored.*companion files/i);
});

test("rejects malformed frontmatter and empty markdown instructions", () => {
  expect(() => validatePersonalSkillSource({ kind: "markdown", markdown: "# No frontmatter" })).toThrow(PersonalSkillValidationError);
  expect(() => validatePersonalSkillSource({ kind: "markdown", markdown: "---\nname: sample\ndescription: Example\n---\n " }))
    .toThrow(PersonalSkillValidationError);
});

test("accepts a UTF-8 BOM before SKILL.md frontmatter", () => {
  const result = validatePersonalSkillSource({ kind: "markdown",
    markdown: "\uFEFF---\nname: notes\ndescription: Notes\n---\nWrite notes." });
  expect(result.content).toEqual({ name: "notes", description: "Notes", instructions: "Write notes." });
});

test("uses the same rules for project skills with project wording", () => {
  const markdown = `---\nname: write-notes\ndescription: Write notes\nallowed-tools: Bash\nlicense: MIT\n---\nWrite notes.`;
  const project = validateSkillSource({ kind: "markdown", markdown }, "project");
  expect(project.content).toEqual(validatePersonalSkillSource({ kind: "markdown", markdown }).content);
  expect(project.validationMessages).toContain("The allowed-tools field is ignored. Project skills cannot grant tools.");
  expect(project.validationMessages).toContain("Compatibility, license, and metadata fields are ignored for project skills.");
  expect(() => validateSkillSource({ kind: "inline", name: "Bad", description: "x", instructions: "x" }, "project"))
    .toThrow(SkillSourceValidationError);
});
