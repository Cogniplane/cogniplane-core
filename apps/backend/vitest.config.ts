import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type CoverageThresholds = {
  lines: number;
  branches: number;
  functions: number;
};

type CoverageThresholdFile = {
  thresholds: CoverageThresholds;
  importedThresholds: CoverageThresholds;
};

// Default coverage counts every production module, including modules no test
// imports. Set COVERAGE_SCOPE=imported to preserve the older imported-module
// measurement as a secondary trend.
const coverageScope = process.env.COVERAGE_SCOPE === "imported" ? "imported" : "full";
const thresholdsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.coverage-thresholds.json"
);
const thresholdFile = JSON.parse(
  readFileSync(thresholdsPath, "utf-8")
) as CoverageThresholdFile;
const thresholds =
  coverageScope === "imported"
    ? thresholdFile.importedThresholds
    : thresholdFile.thresholds;

// Backend tests run in the Node environment. Globals are off — we'll keep
// explicit `import { test, expect, vi } from "vitest"` so a reader doesn't
// have to know which globals come from where.
//
// Discovery matches the existing `tsx --test "src/**/*.test.ts"` glob.
export default defineConfig({
  test: {
    name: "backend",
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Reserve .integration.test.ts for Postgres suites under src/integration/.
    // Hermetic transport tests use .test.ts and run in this project.
    exclude: ["**/node_modules/**", "**/.git/**", "src/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      ...(coverageScope === "full" ? { include: ["src/**/*.ts"] } : {}),
      exclude: [
        "src/**/*.test.ts",
        "src/test-helpers/**",
        // This directory boots and seeds the Postgres integration test rig.
        // The separate integration suite owns it; it is not product code.
        "src/integration/support/**",
        "src/types.d.ts",
        // Declaration-only modules. TypeScript erases every line, so v8 counts
        // them as uncovered source that no test can ever execute. Verify a file
        // holds no runtime value before adding it here.
        "src/services/pii/pii-provider.ts",
        "src/services/integrations/contracts.ts",
        // Keep the imported trend comparable with its old denominator. The
        // full-source run counts production entrypoints and omits only the
        // local dashboard data generator.
        ...(coverageScope === "imported"
          ? ["src/scripts/**", "src/server.ts"]
          : ["src/scripts/seed-dev-data.ts"])
      ],
      thresholds: {
        lines: thresholds.lines,
        branches: thresholds.branches,
        functions: thresholds.functions
      }
    }
  }
});
