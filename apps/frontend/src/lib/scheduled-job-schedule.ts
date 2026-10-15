export type ScheduleMode = "daily" | "weekly" | "custom";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function inferScheduleMode(expression: string): ScheduleMode {
  if (/^\d{1,2} \d{1,2} \* \* \*$/.test(expression)) return "daily";
  if (/^\d{1,2} \d{1,2} \* \* [0-6]$/.test(expression)) return "weekly";
  return "custom";
}

export function scheduleTime(expression: string): string {
  const match = /^(\d{1,2}) (\d{1,2}) /.exec(expression);
  if (!match) return "09:00";
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return "09:00";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function scheduleWeekday(expression: string): number {
  const match = /^\d{1,2} \d{1,2} \* \* ([0-6])$/.exec(expression);
  return match ? Number(match[1]) : 1;
}

export function cronForSchedule(mode: Exclude<ScheduleMode, "custom">, time: string, weekday = 1): string {
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Choose a valid time.");
  }
  return `${minute} ${hour} * * ${mode === "daily" ? "*" : weekday}`;
}

export function scheduleLabel(expression: string): string {
  const mode = inferScheduleMode(expression);
  if (mode === "daily") return `Daily at ${scheduleTime(expression)}`;
  if (mode === "weekly") return `${WEEKDAYS[scheduleWeekday(expression)]} at ${scheduleTime(expression)}`;
  return "Custom schedule";
}

export { WEEKDAYS };
