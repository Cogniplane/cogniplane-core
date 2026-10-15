import { beforeEach, expect, it, vi } from "vitest";

import type { PiiRecentResponse } from "@cogniplane/shared-types";

import { changeAdminMcpWidgetDomain, getAdminMcpWidgetDomains, getAdminPiiRecent, listAdminSessions, listPolicyDecisions } from "./admin-api";
import { request, requestOptionalOn404 } from "./api-client";

vi.mock("./api-client", () => ({ request: vi.fn(), requestOptionalOn404: vi.fn() }));
beforeEach(() => {
  vi.mocked(request).mockReset();
  vi.mocked(requestOptionalOn404).mockReset();
});

function requestedUrl(): URL {
  return new URL(vi.mocked(request).mock.calls[0]![0], "http://localhost");
}

it("sends no query string for policy decisions without filters", async () => {
  vi.mocked(request).mockResolvedValue({ decisions: [], total: 0, hasMore: false, limit: 50, offset: 0 });

  await listPolicyDecisions();

  expect(vi.mocked(request).mock.calls[0]![0]).toBe("/admin/policy/decisions");
});

it("joins multi-value decision filters and keeps false and zero values", async () => {
  vi.mocked(request).mockResolvedValue({ decisions: [], total: 0, hasMore: false, limit: 50, offset: 0 });

  await listPolicyDecisions({
    sessionId: "s1",
    matchedRuleId: "",
    outcomes: ["allow", "block"],
    toolNames: [],
    severities: ["command_execution"],
    enforced: false,
    before: "2026-10-01T00:00:00.000Z",
    limit: 50,
    offset: 0
  });

  const url = requestedUrl();
  expect(url.pathname).toBe("/admin/policy/decisions");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    sessionId: "s1",
    outcomes: "allow,block",
    severities: "command_execution",
    enforced: "false",
    before: "2026-10-01T00:00:00.000Z",
    limit: "50",
    offset: "0"
  });
});

it("serializes admin session filters and skips empty ones", async () => {
  vi.mocked(request).mockResolvedValue({ items: [], nextCursor: null });

  await listAdminSessions({ userId: "u1", status: "active", alert: [], cursor: "c+/=", limit: 25 });

  const url = requestedUrl();
  expect(url.pathname).toBe("/admin/sessions");
  expect(Object.fromEntries(url.searchParams)).toEqual({ userId: "u1", status: "active", cursor: "c+/=", limit: "25" });

  vi.mocked(request).mockClear();
  await listAdminSessions({ alert: ["pii-blocked", "approval-rejected"] });
  expect(requestedUrl().searchParams.get("alert")).toBe("pii-blocked,approval-rejected");
});

const recent: PiiRecentResponse = {
  range: { preset: "custom", from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" }, actions: ["block"], rows: []
};
const optionalUrl = () => new URL(vi.mocked(requestOptionalOn404).mock.calls[0]![0], "http://localhost");

it("asks for recent PII activity of a custom range, with the chosen actions and limit", async () => {
  vi.mocked(requestOptionalOn404).mockResolvedValue(recent);

  expect(await getAdminPiiRecent({
    // limit 0 only checks that a zero is serialized; the backend requires at least 1.
    range: "custom", from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z", actions: ["block", "failed"], limit: 0
  })).toEqual(recent);

  const url = optionalUrl();
  expect(url.pathname).toBe("/admin/pii/recent");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    range: "custom", from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z", actions: "block,failed", limit: "0"
  });
});

it("leaves out empty actions and a missing limit", async () => {
  vi.mocked(requestOptionalOn404).mockResolvedValue({ ...recent, range: { preset: "7d", from: "a", to: "b" } });

  await getAdminPiiRecent({ range: "7d", actions: [] });

  expect(Object.fromEntries(optionalUrl().searchParams)).toEqual({ range: "7d" });
});

it("returns null when the deployment has no recent-activity route", async () => {
  vi.mocked(requestOptionalOn404).mockResolvedValue(undefined);

  expect(await getAdminPiiRecent({ range: "7d" })).toBeNull();
});

const widgetDomains = {
  serverId: "research",
  approved: [{ directive: "connectDomains", source: "https://api.vendor.com", approvedBy: "admin-a", approvedAt: "2026-10-14T10:00:00.000Z" }],
  requested: []
};

it("reads the widget domains of one server with its ID escaped in the path", async () => {
  vi.mocked(request).mockResolvedValue({ widgetDomains });

  expect(await getAdminMcpWidgetDomains("research")).toEqual(widgetDomains);

  expect(vi.mocked(request).mock.calls[0]).toEqual(["/admin/mcp-servers/research/widget-domains"]);
});

it("posts an approval or a removal and returns the new list", async () => {
  vi.mocked(request).mockResolvedValue({ widgetDomains });
  const input = { directive: "connectDomains" as const, source: "https://api.vendor.com" };

  expect(await changeAdminMcpWidgetDomain("research", "approve", input)).toEqual(widgetDomains);
  await changeAdminMcpWidgetDomain("research", "revoke", input);

  expect(vi.mocked(request).mock.calls).toEqual([
    ["/admin/mcp-servers/research/widget-domains/approve", { method: "POST", body: JSON.stringify(input) }],
    ["/admin/mcp-servers/research/widget-domains/revoke", { method: "POST", body: JSON.stringify(input) }]
  ]);
});

it("rejects a widget domains response that has an unknown source list", async () => {
  vi.mocked(request).mockResolvedValue({
    widgetDomains: { ...widgetDomains, approved: [{ ...widgetDomains.approved[0], directive: "scriptDomains" }] }
  });

  await expect(getAdminMcpWidgetDomains("research")).rejects.toThrow();
});
