import { defineConfig } from "vitest/config";

// Root config aggregates per-package projects so `pnpm test:vitest` runs the
// whole monorepo in one Vitest invocation. Per-package configs in
// `apps/backend/vitest.config.ts` and `apps/frontend/vitest.config.ts` carry
// the runtime-environment specifics (node vs. jsdom). The inline `scripts`
// project covers test files under `scripts/`.
export default defineConfig({
  test: {
    projects: [
      "apps/backend/vitest.config.ts",
      "apps/frontend/vitest.config.ts",
      {
        test: {
          name: "scripts",
          environment: "node",
          globals: false,
          include: ["scripts/*.test.ts"]
        }
      }
    ]
  }
});
