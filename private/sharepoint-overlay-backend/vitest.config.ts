import { defineConfig } from "vitest/config";

// Mirrors apps/backend/vitest.config.ts in spirit but without coverage
// thresholds — the overlay is small enough that the workspace-level
// thresholds don't apply here.
export default defineConfig({
  test: {
    execArgv: process.env.VITEST_DISABLE_CONCURRENT_RECOMPILATION === "1"
      ? ["--no-concurrent-recompilation", "--no-maglev"]
      : [],
    name: "sharepoint-overlay-backend",
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"]
  }
});
