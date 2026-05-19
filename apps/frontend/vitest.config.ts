import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend tests today are utility/hook level and don't need a DOM.
// jsdom + @testing-library/react can be added when component-level tests
// arrive.
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});
