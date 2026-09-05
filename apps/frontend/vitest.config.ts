import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const thresholdsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.coverage-thresholds.json"
);
type CoverageThresholds = {
  lines: number;
  branches: number;
  functions: number;
};

const coverageThresholds = JSON.parse(readFileSync(thresholdsPath, "utf-8")) as {
  frontendThresholds: CoverageThresholds;
  frontendImportedThresholds: CoverageThresholds;
};
const importedCoverage = process.env.COVERAGE_SCOPE === "imported";
const thresholds = importedCoverage
  ? coverageThresholds.frontendImportedThresholds
  : coverageThresholds.frontendThresholds;

// The project default environment is `node`; test files that render hooks or
// components select jsdom per file via a docblock pragma.
//
// @vitejs/plugin-react is required so Vite can transform .tsx imports
// (the frontend tsconfig sets jsx=preserve for Next.js, leaving the JSX
// transform to the bundler).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    name: "frontend",
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // The default gate counts every production module. Imported mode keeps
      // the old tested-module measurement available as a secondary trend.
      ...(importedCoverage ? {} : { include: ["src/**/*.{ts,tsx}"] }),
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/test-helpers/**",
        // Next owns the root bootstrap lifecycle. Feature layouts remain in
        // scope because they contain navigation and data-selection logic.
        "src/app/layout.tsx",
        // These route templates only wrap children in an animation class.
        // List them explicitly so a future template enters the denominator.
        "src/app/admin/template.tsx",
        "src/app/artifacts/template.tsx",
        "src/app/settings/template.tsx"
      ],
      thresholds: {
        lines: thresholds.lines,
        branches: thresholds.branches,
        functions: thresholds.functions
      }
    }
  }
});
