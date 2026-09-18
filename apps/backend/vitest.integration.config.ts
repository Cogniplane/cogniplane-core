import { defineConfig } from "vitest/config";

// Postgres-backed integration project. Separate from the unit project
// (`vitest.config.ts`) for three reasons:
//
//  1. It needs a real database. Unit tests must stay runnable with nothing
//     installed, so the two cannot share a project.
//  2. Coverage. `pnpm test:coverage` runs the backend UNIT config alone, so
//     these tests never enter the coverage denominator. Keep it that way: the
//     thresholds in `.coverage-thresholds.json` are calibrated against
//     imported-module coverage of the unit suite.
//  3. CI runs it as its own job with a `services: postgres` block, so a
//     database flake reads as "integration red", not "tests red".
//
// Gating lives in `support/global-setup.ts`, which returns early when
// INTEGRATION_DATABASE_URL is absent. That guard is required, not defensive:
// `describe.skipIf` in the test files skips tests after discovery and does NOT
// stop globalSetup from running, so without it `pnpm test:all` on a machine
// with no Postgres would try to CREATE DATABASE and fail the workspace run.
export default defineConfig({
  test: {
    name: "backend-integration",
    environment: "node",
    globals: false,
    include: ["src/integration/**/*.integration.test.ts"],
    globalSetup: ["src/integration/support/global-setup.ts"],
    setupFiles: ["src/integration/support/setup.ts"],
    // One database, shared fixture rows, and sweep tests that select by status
    // rather than by id. Parallel files would race. `fileParallelism` is the
    // Vitest 4 spelling; `poolOptions.forks.singleFork` no longer exists and
    // would be silently ignored.
    fileParallelism: false,
    maxWorkers: 1,
    // Migrating a cold database plus the checkpointer DDL runs in globalSetup.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Coverage here is OFF unless `--coverage` is passed, so the points above
    // still hold: `pnpm test:coverage` measures the unit suite alone and the
    // blocking floor never depends on a database. `pnpm test:coverage:merged`
    // opts in to produce the advisory unit + integration report. It writes to
    // its own directory so it cannot overwrite the gate's report, carries no
    // thresholds of its own, and matches the unit run's `include` so the two
    // file lists line up. See scripts/merge-coverage.ts.
    coverage: {
      provider: "v8",
      reporter: ["json-summary"],
      reportsDirectory: "coverage-integration",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test-helpers/**",
        "src/integration/support/**",
        "src/types.d.ts",
        "src/services/pii/pii-provider.ts",
        "src/services/integrations/contracts.ts",
        "src/scripts/seed-dev-data.ts"
      ]
    }
  }
});
