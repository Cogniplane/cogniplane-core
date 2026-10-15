import { defineConfig } from "vitest/config";

// Root config aggregates per-package projects so `pnpm test:vitest` runs the
// whole monorepo in one Vitest invocation. Per-package configs in
// `apps/backend/vitest.config.ts` and `apps/frontend/vitest.config.ts` carry
// the runtime-environment specifics (node vs. jsdom). The inline `scripts`
// project covers test files under `scripts/`. The backend-integration project
// needs a real Postgres and skips itself when INTEGRATION_DATABASE_URL is
// unset, so this stays runnable with nothing installed.
export default defineConfig({
  test: {
    projects: [
      "apps/backend/vitest.config.ts",
      "apps/backend/vitest.integration.config.ts",
      "apps/frontend/vitest.config.ts",
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
