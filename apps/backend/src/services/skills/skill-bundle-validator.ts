import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import {
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_FILE_BYTES,
  MAX_SKILL_BUNDLE_TOTAL_BYTES
} from "./skill-bundle-limits.js";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedTopLevelDirectoryNames = new Set(["assets", "references", "scripts"]);
const allowedTopLevelFileNames = new Set(["SKILL.md", "README.md", "LICENSE"]);

export type SkillBundleValidationMessage = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type ValidatedSkillBundle = {
  bundleName: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string[];
  metadata: Record<string, string>;
  instructions: string;
  files: Array<{
    path: string;
    sizeBytes: number;
  }>;
  contentHash: string;
};

export async function validateSkillBundle(
  bundleRootPath: string
): Promise<{ bundle: ValidatedSkillBundle | null; messages: SkillBundleValidationMessage[] }> {
  const messages: SkillBundleValidationMessage[] = [];
  const bundleName = path.basename(bundleRootPath);

  if (!skillNamePattern.test(bundleName) || bundleName.length > 64) {
    messages.push({
      level: "error",
      path: ".",
      message:
        "Bundle directory name must be 1-64 characters using lowercase letters, numbers, and single hyphens."
    });
    return { bundle: null, messages };
  }

  const files = await collectBundleFiles(bundleRootPath, messages);
  if (messages.some((entry) => entry.level === "error")) {
    return { bundle: null, messages };
  }

  const skillMarkdown = files.find((file) => file.path === "SKILL.md");
  if (!skillMarkdown) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Bundle must contain a SKILL.md file at the skill root."
    });
    return { bundle: null, messages };
  }

  if (!skillMarkdown.content) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Unable to read SKILL.md."
    });
    return { bundle: null, messages };
  }

  const parsed = parseSkillMarkdown(skillMarkdown.content.toString("utf8"), messages);
  if (!parsed) {
    return { bundle: null, messages };
  }

  if (parsed.frontmatter.name !== bundleName) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter name must match the parent directory name."
    });
  }

  if (messages.some((entry) => entry.level === "error")) {
    return { bundle: null, messages };
  }

  return {
    bundle: {
      bundleName,
      description: parsed.frontmatter.description,
      license: parsed.frontmatter.license,
      compatibility: parsed.frontmatter.compatibility,
      allowedTools: parsed.frontmatter.allowedTools,
      metadata: parsed.frontmatter.metadata,
      instructions: parsed.instructions,
      files: files.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes
      })),
      contentHash: await computeBundleHash(files)
    },
    messages
  };
}

type BundleFile = {
  path: string;
  absolutePath: string;
  sizeBytes: number;
  content?: Buffer;
};

async function collectBundleFiles(
  bundleRootPath: string,
  messages: SkillBundleValidationMessage[]
): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  let totalSizeBytes = 0;

  async function walkAndAccumulate(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(bundleRootPath, absolutePath).split(path.sep).join("/");
      const stat = await lstat(absolutePath);
      const isTopLevelEntry = currentPath === bundleRootPath;

      if (stat.isSymbolicLink()) {
        messages.push({
          level: "error",
          path: relativePath,
          message: "Symbolic links are not supported in skill bundles."
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (isTopLevelEntry && !allowedTopLevelDirectoryNames.has(entry.name)) {
          messages.push({
            level: "error",
            path: relativePath,
            message:
              "Unsupported top-level directory. Supported directories are assets, references, and scripts."
          });
          continue;
        }

        await walkAndAccumulate(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        messages.push({
          level: "warning",
          path: relativePath,
          message: "Ignoring unsupported filesystem entry type."
        });
        continue;
      }

      if (isTopLevelEntry && !allowedTopLevelFileNames.has(entry.name)) {
        messages.push({
          level: "error",
          path: relativePath,
          message:
            "Unsupported top-level file. Only SKILL.md, README.md, and LICENSE are allowed at the skill root."
          });
        continue;
      }

      if (files.length >= MAX_SKILL_BUNDLE_FILES) {
        messages.push({
          level: "error",
          path: relativePath,
          message: `Skill bundles may contain at most ${MAX_SKILL_BUNDLE_FILES} files.`
        });
        continue;
      }

      if (stat.size > MAX_SKILL_BUNDLE_FILE_BYTES) {
        messages.push({
          level: "error",
          path: relativePath,
          message: `File exceeds the maximum size of ${MAX_SKILL_BUNDLE_FILE_BYTES} bytes.`
        });
        continue;
      }

      totalSizeBytes += stat.size;
      if (totalSizeBytes > MAX_SKILL_BUNDLE_TOTAL_BYTES) {
        messages.push({
          level: "error",
          path: relativePath,
          message: `Skill bundle files exceed the maximum total size of ${MAX_SKILL_BUNDLE_TOTAL_BYTES} bytes.`
        });
        continue;
      }

      files.push({
        path: relativePath,
        absolutePath,
        sizeBytes: stat.size,
        content: relativePath === "SKILL.md" ? await readFile(absolutePath) : undefined
      });
    }
  }

  await walkAndAccumulate(bundleRootPath);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function parseSkillMarkdown(content: string, messages: SkillBundleValidationMessage[]) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "SKILL.md must start with YAML frontmatter delimited by ---."
    });
    return null;
  }

  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = YAML.parse(match[1]);
  } catch (error) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: error instanceof Error ? `Invalid YAML frontmatter: ${error.message}` : "Invalid YAML frontmatter."
    });
    return null;
  }

  if (typeof parsedFrontmatter !== "object" || parsedFrontmatter === null || Array.isArray(parsedFrontmatter)) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Skill frontmatter must be a key-value mapping."
    });
    return null;
  }

  const frontmatter = parsedFrontmatter as Record<string, unknown>;
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const license = typeof frontmatter.license === "string" ? frontmatter.license.trim() : null;
  const compatibility =
    typeof frontmatter.compatibility === "string" ? frontmatter.compatibility.trim() : null;
  const allowedTools =
    typeof frontmatter["allowed-tools"] === "string"
      ? frontmatter["allowed-tools"].split(/\s+/).filter(Boolean)
      : [];

  if (!name) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter must include a non-empty name."
    });
  } else if (!skillNamePattern.test(name) || name.length > 64) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter name must be 1-64 characters using lowercase letters, numbers, and single hyphens."
    });
  }

  if (!description) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter must include a non-empty description."
    });
  } else if (description.length > 1024) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter description must be 1024 characters or fewer."
    });
  }

  if (compatibility && compatibility.length > 500) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Compatibility must be 500 characters or fewer."
    });
  }

  const metadata = normalizeMetadata(frontmatter.metadata, messages);
  const instructions = match[2].trim();

  return {
    frontmatter: {
      name,
      description,
      license,
      compatibility,
      allowedTools,
      metadata
    },
    instructions
  };
}

function normalizeMetadata(
  value: unknown,
  messages: SkillBundleValidationMessage[]
): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    messages.push({
      level: "error",
      path: "SKILL.md",
      message: "Frontmatter metadata must be a mapping of string keys to string values."
    });
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      messages.push({
        level: "error",
        path: "SKILL.md",
        message: `Metadata value for ${key} must be a string.`
      });
      continue;
    }

    normalized[key] = entry;
  }

  return normalized;
}

async function computeBundleHash(files: BundleFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    await updateHashFromFile(hash, file.absolutePath);
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function updateHashFromFile(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}
