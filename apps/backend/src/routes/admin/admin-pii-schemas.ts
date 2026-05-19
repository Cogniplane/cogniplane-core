// Shared schemas, range resolution, and types used by the admin-pii routes
// and their SQL query helpers. Extracted from admin-pii-routes.ts so the
// route file stays focused on registration + handlers.

import { z } from "zod";

const RANGE_PRESETS = ["24h", "7d", "30d", "custom"] as const;

const rangeShape = {
  range: z.enum(RANGE_PRESETS).default("7d"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
};

// Hard cap on a single range query — 366 days covers any "last year"
// scenario including a leap day. Beyond that, an unbounded scan over
// pii_scan_runs gets expensive and there's no UI affordance for it.
const MAX_CUSTOM_RANGE_MS = 366 * 24 * 3600_000;

const refineCustomRange = (
  value: { range: (typeof RANGE_PRESETS)[number]; from?: string; to?: string },
  ctx: z.RefinementCtx
) => {
  if (value.range !== "custom") return;
  if (!value.from || !value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "from and to are required when range=custom"
    });
    return;
  }
  const fromMs = Date.parse(value.from);
  const toMs = Date.parse(value.to);
  if (fromMs >= toMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "from must be earlier than to"
    });
    return;
  }
  if (toMs - fromMs > MAX_CUSTOM_RANGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "custom range cannot exceed 366 days"
    });
  }
};

export const metricsQuerySchema = z.object(rangeShape).superRefine(refineCustomRange);

export const topQuerySchema = z
  .object({
    ...rangeShape,
    groupBy: z.enum(["user", "session"]).default("user"),
    limit: z.coerce.number().int().min(1).max(50).default(10)
  })
  .superRefine(refineCustomRange);

const RECENT_ACTION_TOKENS = ["allow", "report", "block", "transform", "failed"] as const;
export type RecentActionToken = (typeof RECENT_ACTION_TOKENS)[number];

export const recentQuerySchema = z
  .object({
    ...rangeShape,
    actions: z
      .string()
      .optional()
      .transform((raw) => {
        if (!raw) return ["block", "transform", "failed"] as RecentActionToken[];
        return raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      })
      .pipe(z.array(z.enum(RECENT_ACTION_TOKENS)).min(1)),
    limit: z.coerce.number().int().min(1).max(200).default(50)
  })
  .superRefine(refineCustomRange);

export type ResolvedRange = {
  from: Date;
  to: Date;
  bucket: "hour" | "day";
  /** Same-length window immediately preceding [from, to), used for delta % calc. */
  prevFrom: Date;
  prevTo: Date;
};

export type RangeQuery = {
  range: (typeof RANGE_PRESETS)[number];
  from?: string;
  to?: string;
};

export function resolveRange(query: RangeQuery, now: Date = new Date()): ResolvedRange {
  let from: Date;
  let to: Date;
  if (query.range === "custom") {
    from = new Date(query.from!);
    to = new Date(query.to!);
  } else {
    to = now;
    const hours = query.range === "24h" ? 24 : query.range === "7d" ? 24 * 7 : 24 * 30;
    from = new Date(to.getTime() - hours * 3600_000);
  }
  const spanMs = to.getTime() - from.getTime();
  // Hourly buckets up to ~2 days; daily beyond. The cutoff keeps the time
  // series readable: 30 days hourly = 720 points, too dense for the chart.
  const bucket: "hour" | "day" = spanMs <= 2 * 24 * 3600_000 ? "hour" : "day";
  return {
    from,
    to,
    bucket,
    prevFrom: new Date(from.getTime() - spanMs),
    prevTo: from
  };
}

// ── Query result row types ──────────────────────────────────────────────────

export type Kpi = { current: number; previous: number };
export type KpiDeltas = {
  scans: Kpi;
  findings: Kpi;
  blocked: Kpi;
  transformed: Kpi;
  failed: Kpi;
};

export type TimeSeriesPoint = {
  bucket: string;
  allow: number;
  report: number;
  block: number;
  transform: number;
  failed: number;
};

export type EntityCount = { entityType: string; count: number };
export type ConfidenceRow = { entityType: string; high: number; medium: number; low: number };
export type SubjectRow = { subjectType: string; count: number };
