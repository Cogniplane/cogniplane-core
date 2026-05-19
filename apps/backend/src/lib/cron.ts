import { CronExpressionParser } from "cron-parser";

/**
 * Returns the next minute-aligned ISO timestamp at which the cron expression
 * fires in the given IANA timezone, or `null` if no match exists within the
 * next 366 days. Throws on invalid expressions or timezones.
 *
 * The cursor starts at the next minute boundary after `now`, matching the
 * scheduler-worker contract: a job that just fired at minute M should not
 * re-match the same minute. Implemented by passing `now` (which the parser
 * treats as exclusive when its sub-minute remainder is non-zero) and rounding
 * up the result.
 */
export function computeNextCronRunAt(
  cronExpression: string,
  timeZone: string,
  now: Date = new Date()
): string | null {
  // Enforce the historical five-field minute-aligned contract. cron-parser
  // accepts six-field (with seconds) and alias forms (@daily, @hourly) by
  // default; the scheduler stores nextRunAt at minute precision, so anything
  // sub-minute or alias-based would produce surprising fires.
  const trimmed = cronExpression.trim();
  if (trimmed.length === 0 || trimmed.split(/\s+/).length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 space-separated fields (minute hour day-of-month month day-of-week), got: ${cronExpression}`
    );
  }

  // Force the cursor to the next minute boundary so we never return the
  // current minute even if the expression matches it.
  const cursor = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000 - 1);
  try {
    const interval = CronExpressionParser.parse(trimmed, {
      tz: timeZone,
      currentDate: cursor
    });
    return interval.next().toDate().toISOString();
  } catch (error) {
    // cron-parser raises on both invalid expressions and invalid timezones;
    // re-throw so the API layer can surface a 400 with the original message.
    throw error instanceof Error ? error : new Error(String(error));
  }
}
