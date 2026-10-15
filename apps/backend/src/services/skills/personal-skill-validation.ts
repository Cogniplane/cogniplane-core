import { PersonalSkillContentSchema, type PersonalSkillContent, type PersonalSkillSource } from "@cogniplane/shared-types";
import { parseSkillMarkdown, type SkillBundleValidationMessage } from "./skill-bundle-validator.js";

// Personal and project skills share these instruction-only source rules.
export class SkillSourceValidationError extends Error {
  constructor(message: string) { super(message); }
}
export const PersonalSkillValidationError = SkillSourceValidationError;
export type PersonalSkillValidationError = SkillSourceValidationError;

export type ValidatedPersonalSkill = { content: PersonalSkillContent; validationMessages: string[] };
export type SkillSourceOwner = "personal" | "project";

export function validatePersonalSkillSource(source: PersonalSkillSource): ValidatedPersonalSkill {
  return validateSkillSource(source, "personal");
}

export function validateSkillSource(source: PersonalSkillSource, owner: SkillSourceOwner): ValidatedPersonalSkill {
  if (source.kind === "inline") {
    const parsed = PersonalSkillContentSchema.safeParse({
      name: source.name, description: source.description, instructions: source.instructions
    });
    if (!parsed.success) throw new SkillSourceValidationError("Enter a valid name, description, and instructions.");
    return { content: parsed.data, validationMessages: [] };
  }

  const messages: SkillBundleValidationMessage[] = [];
  const parsed = parseSkillMarkdown(source.markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"), messages);
  if (!parsed || messages.some(message => message.level === "error")) {
    throw new SkillSourceValidationError(messages.filter(message => message.level === "error")
      .map(message => message.message).join(" ") || "Invalid SKILL.md.");
  }
  const content = PersonalSkillContentSchema.safeParse({
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    instructions: parsed.instructions
  });
  if (!content.success) throw new SkillSourceValidationError("SKILL.md needs valid, non-empty instructions within the size limit.");
  const label = owner === "personal" ? "Personal" : "Project";
  const warnings = messages.filter(message => message.level === "warning").map(message => message.message);
  warnings.push("Only the name, description, and SKILL.md instructions are saved. Other frontmatter fields have no effect.");
  if (parsed.frontmatter.allowedTools.length) warnings.push(`The allowed-tools field is ignored. ${label} skills cannot grant tools.`);
  if (parsed.frontmatter.compatibility || parsed.frontmatter.license || Object.keys(parsed.frontmatter.metadata).length) {
    warnings.push(`Compatibility, license, and metadata fields are ignored for ${owner} skills.`);
  }
  if (/\]\((?:\.\.?\/|assets\/|references\/|scripts\/)/i.test(parsed.instructions) ||
      /\b(?:assets|references|scripts)\//i.test(parsed.instructions)) {
    warnings.push("Only SKILL.md is saved. Referenced companion files are unavailable in chats.");
  }
  return { content: content.data, validationMessages: warnings };
}
