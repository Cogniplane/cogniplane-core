// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PolicyDecision, PolicyDecisionsListResponse, PolicyRule } from "@cogniplane/shared-types";

import { AdminPolicyDecisionsCard } from "./admin-policy-decisions-card";
import { useDecisionsData } from "../../../hooks/use-policy-data";
import { listPolicyDecisions } from "../../../lib/admin-api";

vi.mock("../../../lib/admin-api", () => ({ listPolicyDecisions: vi.fn(), getPolicyDecision: vi.fn() }));
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => "/admin/policy",
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() })
}));

const SINCE = "2026-09-20T12:00:00.000Z";
const UNTIL = "2026-09-27T12:00:00.000Z";
const rules = [{ ruleId: "pol_writes", name: "Block GitHub writes" }] as PolicyRule[];

function decision(decisionId: string, toolName: string): PolicyDecision {
  return {
    decisionId, tenantId: "t1", sessionId: null, userId: null, runtimeId: null, toolName, toolCategory: null,
    severity: null, serverId: null, matchedRuleId: "pol_writes", outcome: "block", enforced: false,
    explanation: null, createdAt: "2026-09-26T10:00:00.000Z"
  };
}

function page(decisions: PolicyDecision[]): PolicyDecisionsListResponse {
  return { decisions, total: decisions.length, hasMore: false, limit: 25, offset: 0 };
}

function Harness() {
  const data = useDecisionsData();
  return (
    <AdminPolicyDecisionsCard
      decisions={data.decisions} total={data.total} page={data.page} pageCount={data.pageCount}
      offset={data.offset} hasMore={data.hasMore} loading={data.loading} fetching={data.fetching}
      error={data.error} filters={data.filters} urlProblems={data.urlProblems} rules={rules}
      onApply={data.applyFilters} onNext={data.nextPage} onPrev={data.prevPage} onRefresh={data.refresh}
    />
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  return { rerender: () => view.rerender(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) };
}

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  navigation.search = "";
});

it("applies the exact rule, evidence, and window from the URL and shows the scope", async () => {
  navigation.search = `rule=pol_writes&evidence=monitor_gateway&since=${encodeURIComponent(SINCE)}&until=${encodeURIComponent(UNTIL)}&outcome=block`;
  vi.mocked(listPolicyDecisions).mockResolvedValue(page([decision("d1", "github_write_file")]));
  mount();
  expect(await screen.findByText("github_write_file")).toBeTruthy();
  expect(vi.mocked(listPolicyDecisions).mock.calls[0]?.[0]).toMatchObject({
    matchedRuleId: "pol_writes",
    evidence: "monitor_gateway",
    from: SINCE,
    before: UNTIL,
    outcomes: ["block"],
    offset: 0
  });
  expect(screen.getByText("Block GitHub writes")).toBeTruthy();
  expect(screen.getByText("Recorded in Monitor at the MCP gateway")).toBeTruthy();
  expect(screen.getByText("Sep 20, 12:00 to Sep 27, 12:00 UTC")).toBeTruthy();
  expect(screen.getByText("1 rule match in this scope.")).toBeTruthy();
  expect((screen.getByLabelText("From") as HTMLInputElement).disabled).toBe(true);
  // The outcome filter is not part of the scope bar, so the panel starts open and the button counts it.
  const toggle = screen.getByRole("button", { name: "Filter (1)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Apply filters" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Details for github_write_file, / })).toBeTruthy();
});

it("keeps Refresh outside the closed filter panel and names an empty filtered list", async () => {
  navigation.search = "rule=pol_writes&evidence=monitor_gateway";
  vi.mocked(listPolicyDecisions).mockResolvedValue(page([]));
  mount();
  expect(await screen.findByText("No rule matches for these filters.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Filter" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
});

it("names a deleted rule instead of hiding the scope", async () => {
  navigation.search = "rule=pol_removed&evidence=monitor_gateway";
  vi.mocked(listPolicyDecisions).mockResolvedValue(page([]));
  mount();
  expect(await screen.findByText("Deleted or unknown rule")).toBeTruthy();
  expect(screen.getByText("pol_removed")).toBeTruthy();
});

it("shows a link it cannot read and loads no rows", async () => {
  navigation.search = "rule=pol_writes&evidence=all";
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain('The evidence set "all" is not known.');
  expect(listPolicyDecisions).not.toHaveBeenCalled();
  expect(screen.queryByText(/No rule matches yet/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(navigation.replace).toHaveBeenCalledWith("/admin/policy", { scroll: false });
});

it("clears the whole scope and keeps it when other filters apply", async () => {
  navigation.search = `rule=pol_writes&evidence=monitor_gateway&since=${encodeURIComponent(SINCE)}&until=${encodeURIComponent(UNTIL)}`;
  vi.mocked(listPolicyDecisions).mockResolvedValue(page([decision("d1", "github_write_file")]));
  mount();
  await screen.findByText("github_write_file");
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "github_write_file" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  const applied = new URLSearchParams(String(navigation.replace.mock.calls[0]?.[0]).split("?")[1]);
  expect(Object.fromEntries(applied)).toEqual({
    rule: "pol_writes", evidence: "monitor_gateway", since: SINCE, until: UNTIL, tool: "github_write_file"
  });
  fireEvent.click(screen.getByRole("button", { name: "Show all rule matches" }));
  expect(navigation.replace).toHaveBeenLastCalledWith("/admin/policy", { scroll: false });
});

it("does not show rows from the previous scope while the new scope loads", async () => {
  navigation.search = "rule=pol_writes&evidence=monitor_gateway";
  vi.mocked(listPolicyDecisions).mockResolvedValueOnce(page([decision("d1", "old_scope_tool")]));
  const view = mount();
  await screen.findByText("old_scope_tool");
  let finish!: (value: PolicyDecisionsListResponse) => void;
  vi.mocked(listPolicyDecisions).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  navigation.search = "rule=pol_other&evidence=monitor_gateway";
  view.rerender();
  await waitFor(() => expect(screen.queryByText("old_scope_tool")).toBeNull());
  expect(screen.getByText("Loading rule matches…")).toBeTruthy();
  finish(page([decision("d2", "new_scope_tool")]));
  expect(await screen.findByText("new_scope_tool")).toBeTruthy();
});

function firstPage(decisions: PolicyDecision[], total: number): PolicyDecisionsListResponse {
  return { decisions, total, hasMore: true, limit: 25, offset: 0 };
}

it("pins later pages of an unscoped list to the newest row of page 1", async () => {
  const top = { ...decision("d1", "newest_tool"), createdAt: "2026-09-26T10:00:00.123Z" };
  vi.mocked(listPolicyDecisions)
    .mockResolvedValueOnce(firstPage([top], 60))
    .mockResolvedValueOnce({ ...page([decision("d2", "second_page_tool")]), total: 60, offset: 25 });
  mount();
  await screen.findByText("newest_tool");
  expect(vi.mocked(listPolicyDecisions).mock.calls[0]?.[0]?.before).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(await screen.findByText("second_page_tool")).toBeTruthy();
  expect(vi.mocked(listPolicyDecisions).mock.calls[1]?.[0]).toMatchObject({ offset: 25, before: top.createdAt });
});

it("sends the newest createdAt with its microseconds as the bound of later pages", async () => {
  // The server stores microseconds. A bound cut to milliseconds would drop the
  // rows that share the newest timestamp.
  const top = { ...decision("d1", "newest_tool"), createdAt: "2026-09-26T10:00:00.123456Z" };
  vi.mocked(listPolicyDecisions)
    .mockResolvedValueOnce(firstPage([top], 60))
    .mockResolvedValueOnce({ ...page([decision("d2", "second_page_tool")]), total: 60, offset: 25 });
  mount();
  await screen.findByText("newest_tool");
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(await screen.findByText("second_page_tool")).toBeTruthy();
  expect(vi.mocked(listPolicyDecisions).mock.calls[1]?.[0]?.before).toBe("2026-09-26T10:00:00.123456Z");
});

it("keeps the exact window end on every page of a scoped link", async () => {
  navigation.search = `rule=pol_writes&evidence=monitor_gateway&since=${encodeURIComponent(SINCE)}&until=${encodeURIComponent(UNTIL)}`;
  // The newest row is older than the window end and has a shorter timestamp.
  const top = { ...decision("d1", "newest_tool"), createdAt: "2026-09-26T10:00:00.123Z" };
  vi.mocked(listPolicyDecisions)
    .mockResolvedValueOnce(firstPage([top], 60))
    .mockResolvedValueOnce({ ...page([decision("d2", "second_page_tool")]), total: 60, offset: 25 });
  mount();
  await screen.findByText("newest_tool");
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(await screen.findByText("second_page_tool")).toBeTruthy();
  expect(vi.mocked(listPolicyDecisions).mock.calls[1]?.[0]).toMatchObject({ offset: 25, from: SINCE, before: UNTIL });
});
