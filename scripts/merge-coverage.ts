/**
 * Report backend line coverage counting the integration suite alongside the
 * unit suite.
 *
 * The blocking gate (`pnpm test:coverage`) measures the unit suite alone, so a
 * module whose only tests need Postgres reports near zero even when those tests
 * cover it completely. `project-store.ts` is the clearest case: the gate calls
 * it 4.1% while the RLS suite covers every line. That understates how much of
 * the backend is tested and pushes the floor down at every rebaseline.
 *
 * This merge is a REPORT, not a gate. It stays advisory on purpose: the
 * integration job owns its Postgres service container, and making the unit
 * threshold depend on it would turn a database flake into a coverage failure.
 * See the header of apps/backend/vitest.integration.config.ts.
 *
 * Merge rule: a file's covered count is the maximum of the two runs, not the
 * sum, because the same line covered by both suites must not count twice. The
 * maximum is a LOWER BOUND on the true union. Two suites covering different
 * halves of a file report the larger half rather than the whole. Reading the
 * per-line v8 data would give the exact union; the bound is enough to show the
 * gap and cannot overstate it.
 *
 * The denominator stays the unit run's file list, so this number is comparable
 * with the gate's. Files absent from the unit report are ignored, and a file
 * whose two runs disagree on total lines is skipped rather than guessed at.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type LineCounts = { total: number; covered: number };
export type FileSummary = { lines: LineCounts };
export type CoverageSummary = Record<string, FileSummary>;

export type MergedFile = {
  path: string;
  total: number;
  unitCovered: number;
  mergedCovered: number;
};

export type MergeResult = {
  total: number;
  unitCovered: number;
  mergedCovered: number;
  unitPct: number;
  mergedPct: number;
  /** Files the integration run covers better, largest gain first. */
  improved: MergedFile[];
  /** Files skipped because the two runs disagree on the line total. */
  mismatched: string[];
};

function percent(covered: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((covered / total) * 10_000) / 100;
}

export function mergeCoverage(unit: CoverageSummary, integration: CoverageSummary): MergeResult {
  let total = 0;
  let unitCovered = 0;
  let mergedCovered = 0;
  const improved: MergedFile[] = [];
  const mismatched: string[] = [];

  for (const [file, summary] of Object.entries(unit)) {
    if (file === "total") continue;
    const unitLines = summary.lines;
    const integrationLines = integration[file]?.lines;

    // Different instrumentation between runs would make the counts
    // incomparable, so leave the unit figure alone and say which files.
    const comparable = integrationLines && integrationLines.total === unitLines.total;
    if (integrationLines && !comparable) mismatched.push(file);

    const best = comparable
      ? Math.max(unitLines.covered, integrationLines.covered)
      : unitLines.covered;

    total += unitLines.total;
    unitCovered += unitLines.covered;
    mergedCovered += best;

    if (best > unitLines.covered)
      improved.push({
        path: file,
        total: unitLines.total,
        unitCovered: unitLines.covered,
        mergedCovered: best,
      });
  }

  improved.sort(
    (a, b) =>
      percent(b.mergedCovered, b.total) -
      percent(b.unitCovered, b.total) -
      (percent(a.mergedCovered, a.total) - percent(a.unitCovered, a.total)),
  );

  return {
    total,
    unitCovered,
    mergedCovered,
    unitPct: percent(unitCovered, total),
    mergedPct: percent(mergedCovered, total),
    improved,
    mismatched,
  };
}

export function formatReport(result: MergeResult, repoRoot: string): string {
  const relative = (filePath: string) => filePath.replace(`${repoRoot}/`, "");
  const lines = [
    "Backend line coverage, unit suite versus unit + integration",
    "",
    `  unit only        ${result.unitPct}%  (${result.unitCovered}/${result.total})`,
    `  unit + integration ${result.mergedPct}%  (${result.mergedCovered}/${result.total})`,
    "",
  ];

  if (result.improved.length === 0) {
    lines.push("No file gains coverage from the integration suite.");
  } else {
    lines.push(`${result.improved.length} files the integration suite covers better:`);
    for (const file of result.improved.slice(0, 20))
      lines.push(
        `  ${relative(file.path)}: ` +
          `${percent(file.unitCovered, file.total)}% -> ${percent(file.mergedCovered, file.total)}%`,
      );
    if (result.improved.length > 20)
      lines.push(`  ... and ${result.improved.length - 20} more`);
  }

  if (result.mismatched.length > 0) {
    lines.push("");
    lines.push(
      `${result.mismatched.length} files had different line totals between runs and kept their unit figure:`,
    );
    for (const file of result.mismatched.slice(0, 5)) lines.push(`  ${relative(file)}`);
  }

  lines.push("");
  lines.push("Advisory only. The blocking floor stays on the unit suite.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("Unable to resolve the merge-coverage script path.");
  const repoRoot = path.resolve(path.dirname(scriptPath), "..");
  const backend = path.join(repoRoot, "apps/backend");
  const unitPath = path.join(backend, "coverage/coverage-summary.json");
  const integrationPath = path.join(backend, "coverage-integration/coverage-summary.json");

  const read = async (file: string): Promise<CoverageSummary | null> => {
    try {
      return JSON.parse(await readFile(file, "utf-8")) as CoverageSummary;
    } catch {
      return null;
    }
  };

  const unit = await read(unitPath);
  const integration = await read(integrationPath);

  // Missing reports mean the step ran out of order or the integration job was
  // skipped. Say so and exit 0: this report never fails a build.
  if (!unit) {
    console.log(`No unit coverage summary at ${unitPath}. Run pnpm test:coverage first.`);
    return;
  }
  if (!integration) {
    console.log(
      `No integration coverage summary at ${integrationPath}. ` +
        "Run pnpm test:coverage:integration with a database first.",
    );
    return;
  }

  console.log(formatReport(mergeCoverage(unit, integration), repoRoot));
}

// Only run when invoked as a script, not when imported by tests.
if (path.basename(process.argv[1] ?? "") === "merge-coverage.ts") {
  void main();
}
