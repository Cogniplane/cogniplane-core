import { MCP_APP_CSP_DIRECTIVES, type AdminMcpWidgetDomains, type McpAppCspDirective } from "@cogniplane/shared-types";

export type WidgetDomainRow = {
  directive: McpAppCspDirective;
  source: string;
  approved: boolean;
  /** When a widget last asked for this source, or null when none did. */
  lastRequestedAt: string | null;
  approvedBy: string | null;
};

/**
 * One row for each source that a widget asked for or that an administrator
 * approved. A source that is waiting for a decision comes first, the most
 * recent request first. Approved sources follow, in the order of the lists.
 */
export function widgetDomainRows(view: AdminMcpWidgetDomains): WidgetDomainRow[] {
  const keyOf = (entry: { directive: string; source: string }) => `${entry.directive}\n${entry.source}`;
  const approved = new Map(view.approved.map((entry) => [keyOf(entry), entry]));
  const requested = new Map(view.requested.map((entry) => [keyOf(entry), entry]));
  const rows: WidgetDomainRow[] = [];
  for (const entry of view.requested) {
    rows.push({
      directive: entry.directive,
      source: entry.source,
      approved: approved.has(keyOf(entry)),
      lastRequestedAt: entry.lastSeenAt,
      approvedBy: approved.get(keyOf(entry))?.approvedBy ?? null
    });
  }
  for (const entry of view.approved) {
    if (requested.has(keyOf(entry))) continue;
    rows.push({ directive: entry.directive, source: entry.source, approved: true, lastRequestedAt: null, approvedBy: entry.approvedBy });
  }
  const listOrder = (directive: McpAppCspDirective) => MCP_APP_CSP_DIRECTIVES.indexOf(directive);
  const time = (value: string | null) => (value ? new Date(value).getTime() : 0);
  return rows.sort((a, b) =>
    Number(a.approved) - Number(b.approved) ||
    (a.approved ? 0 : time(b.lastRequestedAt) - time(a.lastRequestedAt)) ||
    listOrder(a.directive) - listOrder(b.directive) ||
    a.source.localeCompare(b.source)
  );
}
