import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Coverage thresholds are sourced from the repo-root .coverage-thresholds.json
// so out-of-process CI tooling and Vitest stay in lockstep. See
// `.coverage-thresholds.json` for the documented baseline.
const thresholdsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.coverage-thresholds.json"
);
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf-8")).thresholds as {
  lines: number;
  branches: number;
  functions: number;
};

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
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Match the previous `tsx --test --experimental-test-coverage` reporting
      // scope: only files actually loaded by tests count toward the totals.
      // Coverage of untested production files (stores faked end-to-end in
      // tests) shows as 0% — that's the design, not a regression.
      // No `include` here intentionally; that switches Vitest from
      // "measure every src file" to "measure only files imported by tests".
      exclude: [
        "src/**/*.test.ts",
        "src/test-helpers/**",
        "src/scripts/**",
        "src/types.d.ts",
        "src/server.ts"
      ],
      thresholds: {
        lines: thresholds.lines,
        branches: thresholds.branches,
        functions: thresholds.functions
      }
    }
  }
});
