import { describe, expect, test, vi } from "vitest";

import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import type { JiraReadResult } from "../integrations/pipedream/jira-connection-service.js";
import { createJiraTools, JIRA_READ_TOOL_IDS } from "./jira-tools.js";

const site = { siteId: "11111111-2222-4333-8444-555555555555", name: "Acme", url: "https://acme.atlassian.net" };
const context = { tenantId: "tenant-a", userId: "user-1", toolContextId: "ctx_1" } as ToolExecutionContext;

function tools(result: JiraReadResult) {
  const read = vi.fn(async () => result);
  const byName = Object.fromEntries(createJiraTools({ jiraConnections: { read } }).map((tool) => [tool.name, tool]));
  const call = (name: string, args: Record<string, unknown>) => byName[name].handler({ context, arguments: args });
  return { read, call, byName };
}

describe("Jira tools", () => {
  test("are all read-only and match the descriptor tool IDs", () => {
    const { byName } = tools({ ok: true, data: null, site });
    expect(Object.keys(byName)).toEqual(JIRA_READ_TOOL_IDS);
    expect(Object.values(byName).every((tool) => tool.readOnly)).toBe(true);
  });

  test("search returns one page with its continuation token and compact fields", async () => {
    const { read, call } = tools({
      ok: true,
      site,
      data: {
        issues: [{ id: "1", key: "ABC-1", self: "https://x", fields: { summary: "S", status: { name: "Done", self: "https://x", iconUrl: "i" } } }],
        nextPageToken: "next-1",
        isLast: false
      }
    });
    const output = await call("jira_search_issues", { toolContextId: "ctx_1", jql: "project = ABC", maxResults: 1 });

    // The context has no account record, so no account is passed for comparison.
    expect(read).toHaveBeenCalledWith("tenant-a", "user-1", expect.objectContaining({
      kind: "search", jql: "project = ABC", maxResults: 1, nextPageToken: null
    }), undefined);
    expect(output).toEqual({
      site,
      issues: [{ id: "1", key: "ABC-1", url: "https://acme.atlassian.net/browse/ABC-1", fields: { summary: "S", status: { name: "Done" } } }],
      isLast: false,
      nextPageToken: "next-1"
    });
  });

  test("search marks the last page when Jira omits the token", async () => {
    const { call } = tools({ ok: true, site, data: { issues: [] } });
    expect(await call("jira_search_issues", { toolContextId: "ctx_1", jql: "project = ABC" }))
      .toMatchObject({ isLast: true, nextPageToken: null });
  });

  test("changelog returns the next offset until the last page", async () => {
    const { call } = tools({
      ok: true,
      site,
      data: {
        startAt: 0,
        maxResults: 2,
        total: 5,
        isLast: false,
        values: [
          { id: "10", created: "2026-09-29T10:00:00.000+0000", author: { accountId: "a1", displayName: "Ann", avatarUrls: {} },
            items: [{ field: "status", fromString: "In Progress", toString: "Done" }] },
          { id: "11", created: "2026-09-29T11:00:00.000+0000", items: [] }
        ]
      }
    });
    const output = await call("jira_get_issue_changelog", { toolContextId: "ctx_1", issueKey: "ABC-1", maxResults: 2 });
    expect(output).toMatchObject({ startAt: 0, total: 5, isLast: false, nextStartAt: 2 });
    expect((output.histories as unknown[])[0]).toEqual({
      id: "10",
      created: "2026-09-29T10:00:00.000+0000",
      author: { accountId: "a1", displayName: "Ann" },
      items: [{ field: "status", fromString: "In Progress", toString: "Done" }]
    });
  });

  test("changelog derives the next offset from total when Jira omits isLast", async () => {
    const { call } = tools({ ok: true, site, data: { startAt: 0, total: 3, values: [{ id: "1" }, { id: "2" }] } });
    expect(await call("jira_get_issue_changelog", { toolContextId: "ctx_1", issueKey: "ABC-1", maxResults: 2 }))
      .toMatchObject({ isLast: false, nextStartAt: 2 });
  });

  test.each([
    ["search without issues", "jira_search_issues", { isLast: true }],
    ["search with a wrong issues shape", "jira_search_issues", { issues: [{ key: 5 }], isLast: true }],
    ["search with a non-object body", "jira_search_issues", "<html>"],
    ["issue without a key", "jira_get_issue", { id: "1", fields: {} }],
    ["issue with fields that are not an object", "jira_get_issue", { id: "1", key: "ABC-1", fields: [] }],
    ["changelog without values", "jira_get_issue_changelog", { startAt: 0, isLast: true }],
    ["changelog with a wrong values shape", "jira_get_issue_changelog", { values: {}, isLast: true }],
    ["changelog without isLast or total", "jira_get_issue_changelog", { startAt: 0, values: [{ id: "1" }] }]
  ])("returns an error for a malformed body: %s", async (_label, tool, data) => {
    const { call } = tools({ ok: true, site, data });
    expect(await call(tool, { toolContextId: "ctx_1", jql: "project = ABC", issueKey: "ABC-1" }))
      .toEqual({ error: "Jira returned a response in an unexpected format. Try again later." });
  });

  test.each([
    ["search that is not last and has no token", "jira_search_issues", { issues: [], isLast: false }],
    ["search with an empty token", "jira_search_issues", { issues: [], isLast: false, nextPageToken: "" }],
    ["empty changelog page that is not last", "jira_get_issue_changelog", { startAt: 10, total: 50, isLast: false, values: [] }],
    ["empty changelog page short of total", "jira_get_issue_changelog", { startAt: 10, total: 50, values: [] }]
  ])("returns an error for inconsistent paging: %s", async (_label, tool, data) => {
    const { call } = tools({ ok: true, site, data });
    const output = await call(tool, { toolContextId: "ctx_1", jql: "project = ABC", issueKey: "ABC-1" });
    expect(output).toHaveProperty("error");
    expect(output).not.toHaveProperty("isLast");
  });

  test("returns service errors as tool errors", async () => {
    const { call } = tools({ ok: false, error: "Jira reads are disabled for this organization." });
    expect(await call("jira_list_sites", { toolContextId: "ctx_1" }))
      .toEqual({ error: "Jira reads are disabled for this organization." });
  });

  test("rejects malformed arguments before reading", async () => {
    const { read, call } = tools({ ok: true, site, data: {} });
    expect(await call("jira_search_issues", { toolContextId: "ctx_1", jql: 5 })).toHaveProperty("error");
    expect(await call("jira_get_issue", { toolContextId: "ctx_1", issueKey: "ABC-1", fields: "summary" })).toHaveProperty("error");
    expect(read).not.toHaveBeenCalled();
  });
});
