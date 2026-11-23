import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = path.resolve(SRC_DIR, "../../../private");

// The host files that an overlay backend can import. A test file can also
// import the two test entry points.
const SOURCE_ENTRY_POINTS = ["overlay-sdk", "overlay-contracts"];
const TEST_ENTRY_POINTS = [
  ...SOURCE_ENTRY_POINTS,
  "test-helpers/overlay-testing",
  "integration/support/overlay-testing"
];

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/** Module names in imports, re-exports, dynamic imports, `declare module` and `vi.mock`. */
function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\bdeclare\s+module\s+|\bvi\.(?:do)?mock\(\s*)["']([^"']+)["']/g
  )].map((match) => match[1]!);
}

/**
 * The reason why an overlay file must not use this module name, or null. A
 * relative name is resolved from the file, so the depth of the file does not
 * change the result.
 */
function hostImportViolation(file: string, specifier: string): string | null {
  if (specifier === "@cogniplane/backend" || specifier.startsWith("@cogniplane/backend/")) {
    return "use the relative path of a host entry point";
  }
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(path.dirname(file), specifier);
  if (isWithin(path.resolve(SRC_DIR, "../../frontend"), target)) return "a backend overlay must not import the frontend";
  if (!isWithin(SRC_DIR, target)) return null;
  const hostModule = path.relative(SRC_DIR, target).split(path.sep).join("/").replace(/\.(js|ts)$/, "");
  const allowed = isTestFile(file) ? TEST_ENTRY_POINTS : SOURCE_ENTRY_POINTS;
  return allowed.includes(hostModule) ? null : `${hostModule} is not a host entry point`;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function overlayBackendFiles(): string[] {
  if (!existsSync(PRIVATE_DIR)) return [];
  return readdirSync(PRIVATE_DIR)
    .filter((name) => name.endsWith("-backend") && existsSync(path.join(PRIVATE_DIR, name, "src")))
    .flatMap((name) => listSourceFiles(path.join(PRIVATE_DIR, name, "src")));
}

describe("overlay import boundary", () => {
  it("lets overlay backends import host code only through the entry points", () => {
    const files = overlayBackendFiles();
    const violations = files.flatMap((file) =>
      moduleSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
        const reason = hostImportViolation(file, specifier);
        return reason ? [`${path.relative(PRIVATE_DIR, file)}: "${specifier}" (${reason})`] : [];
      })
    );

    // A distribution without the bundled overlay has no file to scan.
    const bundlesAnOverlay = readFileSync(path.join(SRC_DIR, "overlays.ts"), "utf8").includes("@cogniplane-private/");
    expect(files.length > 0).toBe(bundlesAnOverlay);
    expect(violations).toEqual([]);
  });

  it("keeps the entry points out of core", () => {
    const entryFiles = ["overlay-sdk.ts", "test-helpers/overlay-testing.ts", "integration/support/overlay-testing.ts"]
      .map((file) => path.join(SRC_DIR, file));
    const importers = listSourceFiles(SRC_DIR)
      .filter((file) => !entryFiles.includes(file) && !isTestFile(file))
      .filter((file) => moduleSpecifiers(readFileSync(file, "utf8")).some((specifier) =>
        specifier.startsWith(".") &&
        entryFiles.includes(path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts"))))
      .map((file) => path.relative(SRC_DIR, file));

    expect(importers).toEqual([]);
  });

  const overlayFile = (name: string) => path.join(PRIVATE_DIR, "example-overlay-backend/src/routes", name);
  const host = "../../../../apps/backend/src";

  it.each([
    [`${host}/overlay-sdk.js`, "routes.ts"],
    [`${host}/overlay-contracts.js`, "routes.ts"],
    [`${host}/test-helpers/overlay-testing.js`, "routes.test.ts"],
    [`${host}/integration/support/overlay-testing.js`, "routes.integration.test.ts"],
    ["../services/store.js", "routes.ts"],
    ["@cogniplane/shared-types", "routes.ts"],
    ["fastify", "routes.ts"]
  ])("accepts %s in %s", (specifier, name) => {
    expect(hostImportViolation(overlayFile(name), specifier)).toBeNull();
  });

  it.each([
    [`${host}/lib/db.js`, "routes.ts"],
    [`${host}/services/audit-event-store.js`, "routes.test.ts"],
    [`${host}/test-helpers/overlay-testing.js`, "routes.ts"],
    [`${host}/test-helpers/test-config.js`, "routes.test.ts"],
    [`./../../../../apps/backend/src/overlay-sdk/../lib/db.js`, "routes.ts"],
    ["../../../../apps/frontend/src/lib/api-client", "routes.ts"],
    ["@cogniplane/backend/src/lib/db.js", "routes.ts"]
  ])("refuses %s in %s", (specifier, name) => {
    expect(hostImportViolation(overlayFile(name), specifier)).toEqual(expect.any(String));
  });

  it("reads every form of module name", () => {
    expect(moduleSpecifiers([
      'import { a } from "./a.js";',
      'export { b } from "./b.js";',
      'import "./c.js";',
      'const d = await import("./d.js");',
      'declare module "./e.js" {}',
      'vi.mock("./f.js");',
      'import type {\n  G\n} from "./g.js";'
    ].join("\n"))).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "./g.js"]);
  });
});
