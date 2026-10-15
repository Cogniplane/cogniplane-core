import type { AdminHistoryCategory, AdminHistoryEvent } from "@cogniplane/shared-types";

export const HISTORY_LABELS: Record<AdminHistoryCategory, string> = {
  settings: "Settings", policies: "Policies", people: "People", models: "Models",
  connections: "Connections", skills: "Skills", budgets: "Budgets", runtime: "Runtime"
};
export function historyHref(eventId: string) {
  return `/admin/history?${new URLSearchParams({ event: eventId })}`;
}
export function historyTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }).format(new Date(iso)) + " UTC";
}
export function historyDay(iso: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}
export function versionLabel(event: Pick<AdminHistoryEvent, "settingsVersion" | "createdAt">) {
  return `${event.settingsVersion === null ? "Unversioned record" : `Version ${event.settingsVersion}`} · ${historyTime(event.createdAt)}`;
}
