// License gate — fails CI / `make sync` if any production dependency carries
// strong-copyleft (GPL/AGPL) or source-available (SSPL/BUSL/Elastic-2.0/
// Commons-Clause) terms. The dual-license model (AGPL-3.0 + commercial)
// only holds when every transitive prod dep is AGPL-compatible.
//
// Implementation note: we don't use license-checker / license-checker-rseidelsohn
// because they read npm's flat node_modules layout and miss most packages under
// pnpm's content-addressed `node_modules/.pnpm/` layout. `pnpm licenses list`
// is the authoritative source for this workspace.
//
// Run: `pnpm license:check` (or `pnpm exec tsx scripts/license-check.ts`)

import { execFileSync } from "node:child_process";

// Packages that legitimately ship under proprietary terms but are explicitly
// allowed for this project. Each entry MUST include a justification comment.
//
// Entries match by `name` only — pinning to a version locks us out of
// security patches without value, since the license posture rarely changes
// between minor versions of an upstream package.
const ALLOWED_PROPRIETARY_PACKAGES: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk":
    "Anthropic SDK; proprietary terms via Anthropic's Commercial Terms of Service. Required for the Claude Code runtime.",
  "@anthropic-ai/claude-agent-sdk-linux-x64":
    "Native binary companion to @anthropic-ai/claude-agent-sdk; same proprietary terms.",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64":
    "Native binary companion to @anthropic-ai/claude-agent-sdk for macOS ARM; same proprietary terms."
};

// Licenses that, if found in a non-allowlisted production dependency, MUST
// fail the build. Spelled with the canonical SPDX identifier.
export const FORBIDDEN_LICENSES = new Set<string>([
  "GPL-1.0",
  "GPL-1.0-only",
  "GPL-1.0-or-later",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-1.0",
  "AGPL-1.0-only",
  "AGPL-1.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "SSPL-1.0",
  "BUSL-1.1",
  "Elastic-2.0",
  "Commons-Clause"
]);

type PnpmLicensesEntry = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
};

type PnpmLicensesOutput = Record<string, PnpmLicensesEntry[]>;

function runPnpmLicenses(): PnpmLicensesOutput {
  // --prod restricts to runtime deps; dev-only deps don't need to match the
  // distribution license because they aren't shipped.
  const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(out) as PnpmLicensesOutput;
}

// A license string from pnpm may be a single SPDX id ("MIT"), an SPDX
// expression ("(MIT OR Apache-2.0)" or "MIT AND BSD-2-Clause"), or "Unknown".
//
// Semantics for OR vs AND matter here. With "MIT OR GPL-3.0-or-later"
// (jszip) the *consumer* picks one of the two — choosing MIT keeps us
// compliant, so the dep is acceptable. With "MIT AND GPL-3.0-or-later"
// the consumer must comply with BOTH, so the GPL term taints the whole.
//
// Rule: a license expression is forbidden iff EVERY top-level OR-branch
// contains a forbidden token. A branch is forbidden iff ANY token in it
// (after AND-splitting) is forbidden. WITH clauses (e.g. "GPL-3.0 WITH
// Classpath-exception-2.0") are not currently relevant to this project's
// deps; if one shows up we'll handle it explicitly.
function tokenize(s: string): string[] {
  return s.replace(/[()]/g, " ").split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

function branchHasForbidden(branch: string): string | null {
  for (const tok of tokenize(branch).filter((t) => t.toUpperCase() !== "AND")) {
    if (FORBIDDEN_LICENSES.has(tok)) return tok;
  }
  return null;
}

export function isForbidden(license: string): string | null {
  // Split on top-level OR. (Real SPDX grammar permits parens for grouping;
  // pnpm's output never wraps the whole expression in deeply nested parens
  // for licenses we've seen, so this naive split is sufficient. If we ever
  // hit a counterexample, fall back to a proper SPDX parser.)
  const branches = license.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  let firstForbiddenInAllBranches: string | null = null;
  for (const branch of branches) {
    const forbidden = branchHasForbidden(branch);
    if (!forbidden) return null; // at least one acceptable branch — consumer picks it
    firstForbiddenInAllBranches ??= forbidden;
  }
  return firstForbiddenInAllBranches;
}

function main(): void {
  const data = runPnpmLicenses();

  const violations: string[] = [];
  const unknowns: string[] = [];

  for (const [licenseHeader, entries] of Object.entries(data)) {
    for (const entry of entries) {
      // Defense-in-depth: pnpm groups by header but each entry also carries
      // a `license` field. Use the entry's field — it's authoritative even
      // if pnpm's grouping ever changes shape.
      const declared = entry.license ?? licenseHeader;

      if (declared === "Unknown") {
        if (entry.name in ALLOWED_PROPRIETARY_PACKAGES) continue;
        unknowns.push(`${entry.name}@${entry.versions.join(",")} (license: Unknown)`);
        continue;
      }

      const forbidden = isForbidden(declared);
      if (forbidden && !(entry.name in ALLOWED_PROPRIETARY_PACKAGES)) {
        violations.push(
          `${entry.name}@${entry.versions.join(",")} — ${declared} (matched: ${forbidden})`
        );
      }
    }
  }

  if (violations.length === 0 && unknowns.length === 0) {
    console.log(
      "license:check ok — no forbidden licenses (GPL/AGPL/SSPL/BUSL/Elastic-2.0/Commons-Clause) " +
        "and no Unknown-licensed deps outside the allowlist."
    );
    return;
  }

  let exitCode = 0;
  if (violations.length > 0) {
    console.error(`\n✘ FORBIDDEN LICENSE in production dependencies (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nThe AGPL-3.0 + commercial dual-license model requires every prod dep to be AGPL-compatible. " +
        "Replace the dep, or — if absolutely necessary and approved by counsel — add it to " +
        "ALLOWED_PROPRIETARY_PACKAGES with an explicit justification."
    );
    exitCode = 1;
  }
  if (unknowns.length > 0) {
    console.error(`\n✘ UNKNOWN-licensed production dependencies (${unknowns.length}):`);
    for (const u of unknowns) console.error(`  - ${u}`);
    console.error(
      "\nA dep with no detectable SPDX license is presumed forbidden. Either upstream needs " +
        "to declare a license, or add the package to ALLOWED_PROPRIETARY_PACKAGES with a written justification."
    );
    exitCode = 1;
  }
  process.exit(exitCode);
}

// Only run when invoked as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
