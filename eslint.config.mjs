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
      // `React is not defined` errors because React is loaded via a CDN
      // <script> tag at runtime, not imported.
      "website/assets/architecture-app.js"
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
  // React-hooks + Next.js rules apply only to the frontend tree. They are
  // here (not in apps/frontend/) because we run a single workspace-wide
  // lint config; scoping by `files` keeps backend lint untouched.
  //
  // Plugins are loaded so existing `eslint-disable-next-line
  // react-hooks/exhaustive-deps` and `@next/next/no-sync-scripts`
  // comments resolve instead of erroring with "Definition for rule not
  // found".
  //
  // The react-hooks set no longer downgrades in bulk. A 2026-09-03 audit
  // (bead yegr, clean-code C4) linted the frontend with inline suppressions
  // disabled and found violations in only 4 of the 16 recommended rules. The
  // other 12, including rules-of-hooks, purity, set-state-in-render and
  // immutability, are clean, so they run as errors and now gate. Only the four
  // below stay at "warn", each with the reason it is not an error yet.
  //
  // One trap: the plugin's `recommended` set is not uniformly "error". Three
  // rules ship as "warn" (exhaustive-deps, incompatible-library,
  // unsupported-syntax), so spreading it gates 11, not 12. unsupported-syntax
  // is re-raised to "error" below to close that gap.
  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 23 sites, all deliberate: writes to localStorage or another external
      // system, async fetch-on-mount loading flags, and prop-change resets.
      // Each carries an inline suppression stating which; the 10 that batch 10
      // (bead 1q6n) rewrote were re-triaged afterwards and land in the same
      // three categories. Kept at "warn" so a NEW violation is visible without
      // a reviewer having to know that every existing one was already triaged.
      "react-hooks/set-state-in-effect": "warn",
      // 2 sites, both deliberate single-run effects whose omitted deps must
      // NOT retrigger them: the admin sessions page seeds the URL on first
      // paint, and copilot-chat-host keys its agent on sessionId alone so a
      // model/effort change cannot rebuild the agent and drop a live turn.
      // Re-checked after batch 10 (bead 1q6n) landed; the third site went with
      // use-auto-scroll.ts, but these two are load-bearing and stay.
      "react-hooks/exhaustive-deps": "warn",
      // 1 site: copilot-chat-host.tsx's agent memo reads its refs lazily at
      // send time, not during render, so the rule's heuristic misfires. Also
      // re-checked after batch 10; the pattern survived that rewrite.
      "react-hooks/refs": "warn",
      // 1 site: TanStack Table returns functions React Compiler cannot
      // memoize, so it skips the component. Upstream constraint, not ours.
      "react-hooks/incompatible-library": "warn",
      // No violations, but the plugin ships this one as "warn" in its own
      // recommended set (alongside exhaustive-deps and incompatible-library),
      // so spreading `recommended.rules` alone would leave it ungated. Named
      // explicitly so it errors like the other clean rules.
      "react-hooks/unsupported-syntax": "error",
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
// instead of an error, preserving the original options tuple shape. Used for
// the Next.js set only; the react-hooks set is enabled per rule above.
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
