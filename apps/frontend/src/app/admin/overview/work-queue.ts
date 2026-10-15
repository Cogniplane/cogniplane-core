import { isModelEnabled, type AdminMcpServer, type AdminModelCatalogResponse, type ModelSpendingResponse, type OrganizationSkillSubmission, type TenantSettings } from "@cogniplane/shared-types";
import { budgetStatus, formatMicroUsd, formatMonth } from "../../../lib/model-budget";

export type WorkItem = { id: string; kind: "submission" | "connection" | "model" | "budget"; title: string; detail: string; meta?: string; href: string; action: string };

export function submissionAge(submittedAt: string, now = Date.now()): string {
  const days = Math.floor(Math.max(0, now - new Date(submittedAt).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  return days === 1 ? "1 day waiting" : `${days} days waiting`;
}

export function submissionItems(submissions: OrganizationSkillSubmission[], now = Date.now()): WorkItem[] {
  return submissions.filter((item) => item.status === "pending")
    .sort((a, b) => new Date(a.latest.submittedAt).getTime() - new Date(b.latest.submittedAt).getTime())
    .map((item) => ({
      id: `submission:${item.id}`, kind: "submission", title: item.latest.snapshot.content.name,
      detail: `Submitted by ${item.authorName}${item.authorEmail ? ` (${item.authorEmail})` : ""}`,
      meta: submissionAge(item.latest.submittedAt, now),
      href: `/admin/skills?view=review&submission=${encodeURIComponent(item.id)}`, action: "Review submission"
    }));
}

export function connectionItems(servers: AdminMcpServer[], settings: TenantSettings | undefined): WorkItem[] {
  return servers.flatMap((server) => {
    if (!server.enabled || !(server.isAllowed ?? settings?.enabledMcpServerIds.includes(server.serverId))) return [];
    const problem = server.mode === "proxy" && !server.upstreamUrl ? "Add an upstream URL."
      : server.mode === "proxy" && server.credentialScope !== "personal" && server.upstreamAuthType !== "none" && !server.upstreamAuthConfigured ? "Add an authentication secret." : null;
    if (!problem) return [];
    return [{ id: `connection:${server.serverId}`, kind: "connection" as const, title: server.serverName,
      detail: problem, href: `/admin/connections?connection=${encodeURIComponent(server.serverId)}`, action: "Finish setup" }];
  });
}

export function modelItems(catalog: AdminModelCatalogResponse, settings: TenantSettings): WorkItem[] {
  const missing = catalog.providers.filter((provider) => settings.enabledProviders.includes(provider.id) && provider.keySource === "none");
  const enabledModels = catalog.models.filter((model) => isModelEnabled(model, settings));
  const ready = enabledModels.some((model) => catalog.providers.some((provider) => provider.id === model.provider && provider.keySource !== "none"));
  const items: WorkItem[] = missing.map((provider) => ({
    id: `provider:${provider.id}`, kind: "model", title: provider.label,
    detail: "This enabled provider needs an API key before its models can be used.",
    href: `/admin/models?provider=${encodeURIComponent(provider.id)}`, action: "Add API key"
  }));
  if (!ready) items.push({
    id: "models:none", kind: "model", title: "No models available",
    detail: enabledModels.length ? "Add a provider key so an enabled model can be used." : "Enable a provider and at least one model to make AI work available.", href: "/admin/models", action: "Set up models"
  });
  return items;
}

export const BUDGET_EDIT_HREF = "/admin/token-usage?budget=edit";
export const BUDGET_RECOVERY_HREF = "/admin/token-usage?budget=recovery";

/**
 * At most one budget item. A state that blocks new turns comes before a
 * warning. Without a limit, nothing in the ledger blocks new turns, so there
 * is no item.
 */
export function budgetItems(summary: ModelSpendingResponse): WorkItem[] {
  const status = budgetStatus(summary);
  const hold = formatMicroUsd(status.reservationMicro);
  const used = status.limitMicro === null ? "" : `${formatMicroUsd(status.chargedMicro)} of ${formatMicroUsd(status.limitMicro)} charged or held.`;
  const item = (id: string, title: string, detail: string, href: string, action: string): WorkItem[] =>
    [{ id: `budget:${id}`, kind: "budget", title, detail, href, action }];
  switch (status.level) {
    case "unlimited":
    case "open":
      return [];
    case "off":
      return item("off", "New turns are paused", "The monthly limit is $0.00. No new chat or scheduled turn can start until you change the limit.", BUDGET_EDIT_HREF, "Change budget");
    case "blocked":
      if (status.unknownBlocks) {
        const count = status.unknownThisMonth;
        return item("unknown", "Unknown model usage blocks new turns",
          `${count} ${count === 1 ? "reservation" : "reservations"} this month ${count === 1 ? "has" : "have"} unknown usage. Reconcile ${count === 1 ? "it" : "them"} with the verified cost to start new turns.`
            + (status.insufficient ? " The remaining budget is also too small for one turn." : ""),
          BUDGET_RECOVERY_HREF, "Review reservations");
      }
      return item("exhausted", "Not enough budget for a new turn",
        `${used} A new turn holds ${hold}, which is more than what remains now.`
          + (status.activeThisMonth > 0 ? " Room returns when running turns end and release unused holds." : ""),
        BUDGET_EDIT_HREF, "Change budget");
    case "approaching":
      return item("approaching", `Monthly budget ${status.percent}% used`,
        `${used} New turns stop when less than ${hold} remains.`, "/admin/token-usage", "Review budget");
  }
}

/** One line for the routine list. Reminders about recovery never claim that work is blocked. */
export function budgetRoutineLine(summary: ModelSpendingResponse, month: string): string {
  const status = budgetStatus(summary);
  // Only the first page is known here, so say "some", not a count.
  const olderOpen = summary.unresolved.some((reservation) => reservation.period !== month);
  const recovery = status.unknownThisMonth > 0 || olderOpen ? " Some reservations still need recovery." : "";
  if (status.limitMicro === null) return `No monthly limit.${recovery}`;
  if (status.limitMicro === 0) return `New turns are paused by the $0 monthly limit until you change it.${recovery}`;
  return `${formatMicroUsd(status.chargedMicro)} of ${formatMicroUsd(status.limitMicro)} charged or held in ${formatMonth(month)} (UTC).${recovery}`;
}
