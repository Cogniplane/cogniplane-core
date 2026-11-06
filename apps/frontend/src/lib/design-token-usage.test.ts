import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// `--color-accent` is the hover and focus surface of menus, selects, and ghost
// buttons (see globals.css). As a text, border, or chart color it has almost no
// contrast against the surfaces it sits on. Use info, brand, or a status token.
const FORBIDDEN = [
  /\btext-accent(?![-\w])/,
  /\bborder-accent(?![-\w])/,
  /\b(?:fill|stroke|ring|outline|decoration)-accent(?![-\w])/,
  /\bbg-accent-soft\b/,
  /var\(--color-accent\)/
];

const ROOTS = [
  join(__dirname, ".."),
  join(__dirname, "../../../../private/sharepoint-overlay-frontend/src")
];

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // The public mirror has no private overlay.
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it("never uses the accent hover surface as a foreground, border, or chart color", () => {
  const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        FORBIDDEN.some((pattern) => pattern.test(line)) ? [`${relative(ROOTS[0], file)}:${index + 1}`] : []
      )
  );
  expect(offenders).toEqual([]);
});
