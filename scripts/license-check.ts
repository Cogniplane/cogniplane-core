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
import path from "node:path";
import parseSpdxExpression from "spdx-expression-parse";

// Packages whose registry metadata reports Unknown even though their source
// contains an approved license. Each entry MUST include a justification.
//
// Entries match by `name` only — pinning to a version locks us out of
// security patches without value, since the license posture rarely changes
// between minor versions of an upstream package.
const APPROVED_UNKNOWN_LICENSE_PACKAGES: Record<string, string> = {
  // Actually MIT — the repo ships a LICENSE file
  // (github.com/fabiospampinato/khroma, "The MIT License (MIT)"), but the
  // maintainer omitted the `license` field from package.json, so npm/pnpm
  // report it as Unknown. Transitive dep of mermaid (itself MIT), pulled in
  // via CopilotKit's diagram rendering. Not a real license risk.
  khroma: "MIT (declared in LICENSE file, missing from package.json metadata)"
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

export const INVALID_LICENSE_EXPRESSION = "INVALID_SPDX_EXPRESSION";

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

type SpdxExpression = ReturnType<typeof parseSpdxExpression>;

function findForbiddenLicense(expression: SpdxExpression): string | null {
  if ("license" in expression) {
    if (/^(?:DocumentRef-[^:]+:)?LicenseRef-/.test(expression.license)) {
      return INVALID_LICENSE_EXPRESSION;
    }
    // The SPDX catalog still accepts deprecated composite identifiers such as
    // GPL-2.0-with-classpath-exception. Match the license family so those
    // spellings cannot bypass the explicit canonical-ID list above.
    return FORBIDDEN_LICENSES.has(expression.license) || /^A?GPL-/.test(expression.license)
      ? expression.license
      : null;
  }

  const left = findForbiddenLicense(expression.left);
  const right = findForbiddenLicense(expression.right);

  if (expression.conjunction === "and") {
    return left ?? right;
  }

  return left && right ? left : null;
}

export function isForbidden(license: string): string | null {
  try {
    return findForbiddenLicense(parseSpdxExpression(license));
  } catch {
    return INVALID_LICENSE_EXPRESSION;
  }
}

function hasApprovedUnknownLicenseException(
  packageName: string,
  declaredLicense: string
): boolean {
  return (
    declaredLicense === "Unknown" &&
    Object.prototype.hasOwnProperty.call(APPROVED_UNKNOWN_LICENSE_PACKAGES, packageName)
  );
}

type LicenseIssue =
  | { kind: "unknown" }
  | { kind: "forbidden"; matchedLicense: string };

export function classifyPackageLicense(
  packageName: string,
  declaredLicense: string
): LicenseIssue | null {
  if (declaredLicense === "Unknown") {
    return hasApprovedUnknownLicenseException(packageName, declaredLicense)
      ? null
      : { kind: "unknown" };
  }

  const matchedLicense = isForbidden(declaredLicense);
  return matchedLicense ? { kind: "forbidden", matchedLicense } : null;
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

      const issue = classifyPackageLicense(entry.name, declared);
      if (!issue) continue;

      if (issue.kind === "unknown") {
        unknowns.push(`${entry.name}@${entry.versions.join(",")} (license: Unknown)`);
        continue;
      }

      violations.push(
        `${entry.name}@${entry.versions.join(",")} — ${declared} (matched: ${issue.matchedLicense})`
      );
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
        "the approved exception policy with an explicit justification."
    );
    exitCode = 1;
  }
  if (unknowns.length > 0) {
    console.error(`\n✘ UNKNOWN-licensed production dependencies (${unknowns.length}):`);
    for (const u of unknowns) console.error(`  - ${u}`);
    console.error(
      "\nA dep with no detectable SPDX license is presumed forbidden. Either upstream needs " +
        "to declare a license, or add the package to APPROVED_UNKNOWN_LICENSE_PACKAGES with a written justification."
    );
    exitCode = 1;
  }
  process.exit(exitCode);
}

// Only run when invoked as a script, not when imported by tests.
if (path.basename(process.argv[1] ?? "") === "license-check.ts") {
  main();
}
