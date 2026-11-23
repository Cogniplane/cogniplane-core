import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.join(SRC_DIR, "overlay-sdk");
const PRIVATE_DIR = path.resolve(SRC_DIR, "../../../private");

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Module names in imports, re-exports, dynamic imports, `declare module` and `vi.mock`. */
function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\bdeclare\s+module\s+|\bvi\.(?:do)?mock\(\s*)["']([^"']+)["']/g
  )].map((match) => match[1]!);
}

/**
 * The reason why an overlay file must not use this module name, or null. The
 * host alias `@/` and a relative name both resolve into the host `src`.
 */
function hostImportViolation(file: string, specifier: string): string | null {
  if (specifier === "@cogniplane/frontend" || specifier.startsWith("@cogniplane/frontend/")) {
    return "use the relative path of a host entry point";
  }
  if (specifier.startsWith("@/")) return "use the relative path of a host entry point, not the host alias";
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(path.dirname(file), specifier);
  if (isWithin(path.resolve(SRC_DIR, "../../backend"), target)) return "a frontend overlay must not import the backend";
  if (!isWithin(SRC_DIR, target)) return null;
  // An entry point is a file of the directory, not the directory or a deeper path.
  return path.dirname(target) === SDK_DIR ? null : `${path.relative(SRC_DIR, target)} is not a host entry point`;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function overlayFrontendFiles(): string[] {
  if (!existsSync(PRIVATE_DIR)) return [];
  return readdirSync(PRIVATE_DIR)
    .filter((name) => name.endsWith("-frontend") && existsSync(path.join(PRIVATE_DIR, name, "src")))
    .flatMap((name) => listSourceFiles(path.join(PRIVATE_DIR, name, "src")));
}

describe("overlay import boundary", () => {
  it("lets overlay frontends import host code only through the entry points", () => {
    const files = overlayFrontendFiles();
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
    const importers = listSourceFiles(SRC_DIR)
      .filter((file) => !isWithin(SDK_DIR, file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => moduleSpecifiers(readFileSync(file, "utf8")).some((specifier) =>
        specifier.startsWith("@/overlay-sdk") ||
        (specifier.startsWith(".") && isWithin(SDK_DIR, path.resolve(path.dirname(file), specifier)))))
      .map((file) => path.relative(SRC_DIR, file));

    expect(importers).toEqual([]);
  });

  // The `register` module of an overlay loads on every page. The settings
  // page parts must come with the page, which the overlay loads on demand.
  it("keeps the settings page parts out of the modules that load on every page", () => {
    for (const name of ["registration.ts", "ui.ts", "data.ts"]) {
      const specifiers = moduleSpecifiers(readFileSync(path.join(SDK_DIR, name), "utf8"));
      expect(specifiers.length, name).toBeGreaterThan(0);
      expect(specifiers.filter((specifier) => /oauth-(settings|connection)/.test(specifier)), name).toEqual([]);
    }
  });

  const overlayFile = (name: string) => path.join(PRIVATE_DIR, "example-overlay-frontend/src/components", name);
  const host = "../../../../apps/frontend/src";

  it.each([
    `${host}/overlay-sdk/ui`,
    `${host}/overlay-sdk/registration`,
    "../hooks/use-example",
    "@cogniplane/shared-types",
    "react"
  ])("accepts %s", (specifier) => {
    expect(hostImportViolation(overlayFile("example.tsx"), specifier)).toBeNull();
  });

  it.each([
    `${host}/components/ui/button`,
    `${host}/overlay-sdk`,
    `${host}/overlay-sdk/../lib/api-client`,
    "@/components/ui/button",
    "@/overlay-sdk/ui",
    "../../../../apps/backend/src/overlay-sdk.js",
    "@cogniplane/frontend/src/lib/api-client"
  ])("refuses %s", (specifier) => {
    expect(hostImportViolation(overlayFile("example.tsx"), specifier)).toEqual(expect.any(String));
  });
});
