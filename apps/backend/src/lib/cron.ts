import { CronExpressionParser } from "cron-parser";

/**
 * Returns the next minute-aligned ISO timestamp at which the cron expression
 * fires in the given IANA timezone. Throws on invalid expressions or timezones.
 *
 * The current minute never matches. A job that just fired at minute M should
 * not match minute M again. The scheduler-worker contract relies on this.
 */
export function computeNextCronRunAt(
  cronExpression: string,
  timeZone: string,
  now: Date = new Date()
): string | null {
  // Enforce a five-field, minute-aligned contract. cron-parser accepts six-field
  // (with seconds) and alias forms (@daily, @hourly) by default. The scheduler
  // stores nextRunAt at minute precision, so a sub-minute or alias expression
  // would fire at surprising times.
  const trimmed = cronExpression.trim();
  if (trimmed.length === 0 || trimmed.split(/\s+/).length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 space-separated fields (minute hour day-of-month month day-of-week), got: ${cronExpression}`
    );
  }

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
