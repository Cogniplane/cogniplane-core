import { defineConfig } from "vitest/config";

// Root config aggregates per-package projects so `pnpm test:all` runs the
// whole monorepo in one Vitest invocation. Per-package configs in
// `apps/backend/vitest.config.ts` and `apps/frontend/vitest.config.ts` carry
// the runtime-environment specifics (node vs. jsdom). The inline `scripts`
// project covers test files under `scripts/` (license checks and development tools).
export default defineConfig({
  test: {
    execArgv: process.env.VITEST_DISABLE_CONCURRENT_RECOMPILATION === "1"
      ? ["--no-concurrent-recompilation", "--no-maglev"]
      : [],
    projects: [
      "apps/backend/vitest.config.ts",
      "apps/backend/vitest.integration.config.ts",
      "apps/frontend/vitest.config.ts",
      "private/sharepoint-overlay-backend/vitest.config.ts",
      {
        test: {
          name: "scripts",
          environment: "node",
          globals: false,
          include: ["scripts/*.test.ts"],
          // These tests spawn shell scripts with freshly written shims. Endpoint
          // security can add about 1 s to the first launch of each new executable.
          testTimeout: 30_000
        }
      }
    ]
  }
});
