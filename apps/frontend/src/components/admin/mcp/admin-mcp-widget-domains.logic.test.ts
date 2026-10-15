import { expect, it } from "vitest";
import type { AdminMcpWidgetDomains } from "@cogniplane/shared-types";

import { widgetDomainRows } from "./admin-mcp-widget-domains.logic";

const view = (partial: Partial<AdminMcpWidgetDomains>): AdminMcpWidgetDomains =>
  ({ serverId: "research", approved: [], requested: [], ...partial });
const requested = (directive: "resourceDomains" | "connectDomains" | "frameDomains" | "baseUriDomains", source: string, lastSeenAt: string) =>
  ({ directive, source, firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt });
const approved = (directive: "resourceDomains" | "connectDomains" | "frameDomains" | "baseUriDomains", source: string) =>
  ({ directive, source, approvedBy: "admin-a", approvedAt: "2026-10-10T00:00:00.000Z" });

it("has no row when nothing was requested or approved", () => {
  expect(widgetDomainRows(view({}))).toEqual([]);
});

it("puts a source that waits for a decision first, the latest request first", () => {
  const rows = widgetDomainRows(view({
    requested: [
      requested("connectDomains", "https://old.vendor.com", "2026-10-02T00:00:00.000Z"),
      requested("connectDomains", "https://new.vendor.com", "2026-10-09T00:00:00.000Z"),
      requested("resourceDomains", "https://cdn.vendor.com", "2026-10-12T00:00:00.000Z")
    ],
    approved: [approved("resourceDomains", "https://cdn.vendor.com")]
  }));
  expect(rows.map((row) => [row.source, row.approved])).toEqual([
    ["https://new.vendor.com", false],
    ["https://old.vendor.com", false],
    ["https://cdn.vendor.com", true]
  ]);
});

it("matches a request and an approval by source list and source", () => {
  const rows = widgetDomainRows(view({
    requested: [requested("connectDomains", "https://api.vendor.com", "2026-10-02T00:00:00.000Z")],
    approved: [approved("resourceDomains", "https://api.vendor.com")]
  }));
  // The same host for another purpose is a separate decision.
  expect(rows).toEqual([
    { directive: "connectDomains", source: "https://api.vendor.com", approved: false,
      lastRequestedAt: "2026-10-02T00:00:00.000Z", approvedBy: null },
    { directive: "resourceDomains", source: "https://api.vendor.com", approved: true, lastRequestedAt: null, approvedBy: "admin-a" }
  ]);
});

it("lists approved sources by source list, then by name, and keeps one that no view asked for", () => {
  const rows = widgetDomainRows(view({
    approved: [
      approved("frameDomains", "https://b.vendor.com"),
      approved("connectDomains", "https://z.vendor.com"),
      approved("connectDomains", "https://a.vendor.com"),
      approved("resourceDomains", "https://c.vendor.com")
    ]
  }));
  expect(rows.map((row) => `${row.directive} ${row.source}`)).toEqual([
    "resourceDomains https://c.vendor.com",
    "connectDomains https://a.vendor.com",
    "connectDomains https://z.vendor.com",
    "frameDomains https://b.vendor.com"
  ]);
  expect(rows.every((row) => row.approved && row.lastRequestedAt === null)).toBe(true);
});
