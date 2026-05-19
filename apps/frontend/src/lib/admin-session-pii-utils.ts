import type { AdminSessionDetailPiiRun } from "@cogniplane/shared-types";

export type AggregatedFinding = {
  label: string;
  count: number;
};

export function aggregateFindings(findings: unknown[]): AggregatedFinding[] {
  const buckets = new Map<string, number>();
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) continue;
    const f = finding as Record<string, unknown>;
    const labelRaw = f.kind ?? f.type ?? f.entityType;
    const label = typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw : "finding";
    const countRaw = typeof f.count === "number" ? f.count : 1;
    buckets.set(label, (buckets.get(label) ?? 0) + countRaw);
  }
  return Array.from(buckets.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export function summarizeFindings(findings: unknown[]): string {
  const aggregated = aggregateFindings(findings);
  if (aggregated.length === 0) {
    return `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  }
  return aggregated.map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`).join(", ");
}

export function summarizePiiRun(run: AdminSessionDetailPiiRun): string {
  return summarizeFindings(run.findings);
}
