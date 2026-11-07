import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "apps/backend/bundle/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      ".claude/plugins/**",
      ".claude/worktrees/**",
      ".worktrees/**",
      "**/coverage/**",
      "docs/**",
      // Babel-compiled output of website/src/architecture-app.jsx — generated
      // by `npm run build:arch`. Linting transpiled bundles flags spurious
      // `React is not defined` errors because React is loaded by a separate
      // <script> tag at runtime, not imported.
      "website/assets/architecture-app.js",
      // Vendored third-party libraries (minified React UMD builds), served
      // locally so the architecture page does not depend on a CDN. Not ours
      // to lint or fix.
      "website/assets/vendor/**"
    ]
  },
  js.configs.recommended,
  // Pin the TSConfig root to THIS repo's directory. Without it, typescript-eslint
  // 8.x probes upward for a tsconfig and, when sibling checkouts exist next to
  // this repo (../cogniplane-core, ../cogniplane.demo, …), fails with
  // "No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are
  // present" — a parse error on every file. See tseslint.com/parser-tsconfigrootdir.
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
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
  // React-hooks and Next.js rules apply only to the frontend tree. They sit
  // here, not in apps/frontend/, because one workspace-wide lint config runs
  // everything. Scoping by `files` keeps backend lint untouched.
  //
  // The plugins must load. Existing `eslint-disable-next-line
  // react-hooks/exhaustive-deps` and `@next/next/no-sync-scripts` comments
  // would otherwise fail with "Definition for rule not found".
  //
  // Four react-hooks rules run as warnings, set below, each with its reason.
  // The other react-hooks rules run as errors.
  //
  // The plugin's `recommended` set is not uniformly "error". Three rules ship
  // as "warn" (exhaustive-deps, incompatible-library, unsupported-syntax), so
  // spreading the set alone leaves them as warnings. unsupported-syntax is
  // re-raised to "error" below.
  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The existing sites are deliberate. They write to localStorage or
      // another external system, set loading flags for a fetch on mount, or
      // reset state when a prop changes. Keep the rule at "warn". As errors,
      // these sites would fail lint.
      "react-hooks/set-state-in-effect": "warn",
      // Two sites use deliberate single-run effects. Their omitted deps must
      // NOT retrigger them. The admin sessions page seeds the URL on first
      // paint. copilot-chat-host keys its agent on sessionId alone, so a
      // model or effort change cannot rebuild the agent and drop a live turn.
      "react-hooks/exhaustive-deps": "warn",
      // copilot-chat-host.tsx reads its refs at send time, not during render.
      // The rule's heuristic misfires on this pattern.
      "react-hooks/refs": "warn",
      // TanStack Table returns functions that React Compiler cannot memoize,
      // so the compiler skips the component. This limit comes from upstream.
      "react-hooks/incompatible-library": "warn",
      // The plugin ships this rule as "warn". Set it to "error" here, so the
      // spread of `recommended.rules` does not leave it ungated.
      "react-hooks/unsupported-syntax": "error",
      ...downgradeToWarn(nextPlugin.configs.recommended.rules),
      // App Router only — no pages/ dir for this rule to validate against.
      "@next/next/no-html-link-for-pages": "off",
      // Boundary guard: the frontend uses backend functionality only through
      // @cogniplane/shared-types contracts. It must not import backend code.
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

// Sets each rule in a recommended-rules object to "warn". Keeps each rule's
// options. Used for the Next.js set only. The config sets the react-hooks rules
// one by one above.
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
