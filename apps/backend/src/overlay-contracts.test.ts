import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = path.resolve(SRC_DIR, "../../../private");

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isPrivateImport(file: string, specifier: string): boolean {
  return specifier.startsWith("@cogniplane-private/") ||
    ((specifier.startsWith(".") || path.isAbsolute(specifier)) &&
      isWithin(PRIVATE_DIR, path.resolve(path.dirname(file), specifier)));
}

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

// These guards cover the overlay entrypoint only. Overlay packages still import
// backend helpers directly; see docs/overlays.md.
describe("overlay contract boundary", () => {
  it("keeps the contract module inside core", () => {
    const specifiers = importSpecifiers(path.join(SRC_DIR, "overlay-contracts.ts"));

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier === "fastify" ||
        (specifier.startsWith("./") && isWithin(SRC_DIR, path.resolve(SRC_DIR, specifier))), specifier).toBe(true);
    }
  });

  it("imports overlay packages only from the overlays shim", () => {
    const importers = listSourceFiles(SRC_DIR)
      .filter((file) => importSpecifiers(file).some((specifier) => isPrivateImport(file, specifier)))
      .map((file) => path.relative(SRC_DIR, file));

    expect(importers.filter((file) => file !== "overlays.ts")).toEqual([]);
  });

  it.each([
    "@cogniplane-private/sharepoint-overlay-backend",
    "../../../private/sharepoint-overlay-backend/src/index.js",
    "./../../../private/sharepoint-overlay-backend/src/index.js"
  ])("detects private imports through %s", (specifier) => {
    expect(isPrivateImport(path.join(SRC_DIR, "consumer.ts"), specifier)).toBe(true);
  });
});
