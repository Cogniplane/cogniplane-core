import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      ".claude/plugins/**",
      ".worktrees/**",
      "**/coverage/**",
      "docs/**",
      // Babel-compiled output of website/src/architecture-app.jsx — generated
      // by `npm run build:arch`. Linting transpiled bundles flags spurious
      // `React is not defined` errors because React is loaded via a CDN
      // <script> tag at runtime, not imported.
      "website/assets/architecture-app.js"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // Convention across the codebase: a leading underscore on an unused
      // identifier signals "intentionally unused" (e.g. function args kept
      // for signature compatibility, destructured-and-discarded keys).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_"
        }
      ]
    }
  },
  // React-hooks + Next.js rules apply only to the frontend tree. They are
  // here (not in apps/frontend/) because we run a single workspace-wide
  // lint config; scoping by `files` keeps backend lint untouched.
  //
  // Plugins are loaded so existing `eslint-disable-next-line
  // react-hooks/exhaustive-deps` and `@next/next/no-sync-scripts`
  // comments resolve instead of erroring with "Definition for rule not
  // found". The rule severity is downgraded to "warn" in bulk because the
  // pre-existing codebase has ~40 violations that are out of scope for
  // any single feature PR — they need their own dedicated cleanup pass.
  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin
    },
    rules: {
      ...downgradeToWarn(reactHooks.configs.recommended.rules),
      ...downgradeToWarn(nextPlugin.configs.recommended.rules),
      // App Router only — no pages/ dir for this rule to validate against.
      "@next/next/no-html-link-for-pages": "off",
      // Boundary guard: the frontend may only consume backend functionality
      // through @cogniplane/shared-types contracts, never by importing
      // backend code directly. Held by convention until now; enforced here.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@cogniplane/backend",
                "@cogniplane/backend/**",
                "**/apps/backend/**",
                "**/backend/src/**"
              ],
              message: "Frontend must not import backend code — use @cogniplane/shared-types contracts."
            }
          ]
        }
      ]
    }
  }
);

// Helper: rewrite a recommended-rules object so every entry runs as a warning
// instead of an error, preserving the original options tuple shape.
function downgradeToWarn(rules) {
  const result = {};
  for (const [name, value] of Object.entries(rules)) {
    if (Array.isArray(value)) {
      result[name] = ["warn", ...value.slice(1)];
    } else {
      result[name] = "warn";
    }
  }
  return result;
}
