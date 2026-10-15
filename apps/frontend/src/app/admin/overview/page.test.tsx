// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSkillSubmission } from "@cogniplane/shared-types";
import AdminOverviewPage from "./page";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import { getAdminModelCatalog, getPolicyMonitorSummary, getTenantSettings, listAdminMcpServers, listAdminSkills, listAdminSessions } from "../../../lib/admin-api";
import { listAdminSkillSubmissions } from "../../../lib/organization-skill-submissions-api";
import { getModelSpending } from "../../../lib/model-spending-api";
import { useAuth } from "../../../lib/auth-context";
import { queryKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/admin-api", () => ({ getAdminModelCatalog: vi.fn(), getPolicyMonitorSummary: vi.fn(), getTenantSettings: vi.fn(), listAdminMcpServers: vi.fn(), listAdminSkills: vi.fn(), listAdminSessions: vi.fn() }));
vi.mock("../../../lib/organization-skill-submissions-api", () => ({ listAdminSkillSubmissions: vi.fn() }));
vi.mock("../../../lib/model-spending-api", () => ({ getModelSpending: vi.fn() }));
vi.mock("../../../lib/auth-context", () => ({ useAuth: vi.fn() }));
const scope = { tenantId: "tenant-one", userId: "admin-one" };

function submission(): OrganizationSkillSubmission {
  return { id: "11111111-1111-4111-8111-111111111111", version: 1, status: "pending", authorUserId: "author-one", authorName: "Ada Lovelace", authorEmail: "ada@example.test",
    sourceSkillId: "personal-skill-one", targetOrganizationSkillId: null, acceptedOrganizationSkillId: null,
    latest: { attempt: 1, status: "pending", note: "", snapshot: { content: { name: "research-brief", description: "A brief", instructions: "Do research" }, sourceRevision: 1, contentHash: "a".repeat(64), validationMessages: [] }, submittedAt: "2026-09-22T00:00:00Z", decidedAt: null, decidedBy: null, decidedByName: null, feedback: null, acceptedRevisionId: null },
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" };
}

vi.mock("../../../lib/admin-history-api", () => ({ listAdminHistory: async () => ({ items: [], nextCursor: null }) }));

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { ...scope, email: "admin@example.test", displayName: "Admin", role: "admin" }, accessToken: null, isLoading: false, login: vi.fn(), logout: vi.fn(), refreshToken: vi.fn(), completeLogin: vi.fn() });
  vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
  vi.mocked(getAdminModelCatalog).mockResolvedValue({ models: [], providers: [] });
  vi.mocked(listAdminMcpServers).mockResolvedValue([]);
  vi.mocked(listAdminSkills).mockResolvedValue([]);
  vi.mocked(listAdminSessions).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [] });
  vi.mocked(getModelSpending).mockResolvedValue(spending(null, 0));
  vi.mocked(getPolicyMonitorSummary).mockResolvedValue(monitorSummary());
});

function monitorSummary() {
  return {
    windowStart: "2026-09-20T12:00:00.000Z",
    windowEnd: "2026-09-27T12:00:00.000Z",
    totals: { block: 4, approvalInteractive: 1, approvalScheduled: 1, approvalUnknownContext: 0, total: 6 },
    rules: [{
      ruleId: "pol_writes",
      currentRule: { name: "Block GitHub writes", enabled: true, effect: "block" as const },
      counts: { block: 4, approvalInteractive: 1, approvalScheduled: 1, approvalUnknownContext: 0, total: 6 },
      lastRecordedAt: "2026-09-26T10:00:00.000Z"
    }],
    excluded: { resourceChecks: 0, unrecognized: 0 }
  };
}

function spending(limit: number | null, charged: number, unknownReservations = 0) {
  return { policy: { monthlyLimitUsd: limit, turnReservationUsd: 1, version: 1 }, chargedUsd: charged,
    activeReservations: 0, unknownReservations, unresolved: [], nextCursor: null };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminOverviewPage /></QueryClientProvider>);
  return client;
}

it("keeps pending review, setup blockers, and the policy row accessible", async () => {
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [submission()] });
  mount();
  expect((await screen.findByRole("link", { name: "Review submission" })).getAttribute("href"))
    .toBe("/admin/skills?view=review&submission=11111111-1111-4111-8111-111111111111");
  expect(screen.getByText("Submitted by Ada Lovelace (ada@example.test)")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Set up models" }).getAttribute("href")).toBe("/admin/models");
  expect(screen.getByText(/^Monitor mode\./)).toBeTruthy();
});

it("does not claim a quiet state while checks are loading or failed", async () => {
  let finish!: (value: { scope: typeof scope; submissions: OrganizationSkillSubmission[] }) => void;
  vi.mocked(listAdminSkillSubmissions).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mount();
  expect(screen.getByRole("status", { name: "Checking work queue" })).toBeTruthy();
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
  finish({ scope, submissions: [] });
  expect(await screen.findByText("No models available")).toBeTruthy();
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
});

it("keeps available work when the submission check fails, then retries it", async () => {
  vi.mocked(listAdminSkillSubmissions).mockRejectedValueOnce(new Error("Network failed")).mockResolvedValueOnce({ scope, submissions: [submission()] });
  mount();
  expect(await screen.findByText("Could not check skill submissions.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Set up models" })).toBeTruthy();
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry skill submissions" }));
  expect(await screen.findByRole("link", { name: "Review submission" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Could not check skill submissions.")).toBeNull());
});

it("does not render submissions returned for a different account", async () => {
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope: { tenantId: "other-tenant", userId: "other-admin" }, submissions: [submission()] });
  mount();
  expect(await screen.findByText("Could not check skill submissions.")).toBeTruthy();
  expect(screen.queryByText("research-brief")).toBeNull();
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
});

it("shows the quiet state only after every queue check succeeds", async () => {
  vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: null }));
  vi.mocked(getAdminModelCatalog).mockResolvedValue({ providers: [{ id: "openai", label: "OpenAI", keySource: "tenant" }], models: [{ id: "openai/test", displayName: "Test", description: "", isDefault: false, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }] });
  mount();
  expect(await screen.findByText("Nothing needs attention.")).toBeTruthy();
  expect(screen.getByText("1 model ready to use.")).toBeTruthy();
});

it("puts a blocked budget in the queue with a direct link to recovery", async () => {
  vi.mocked(getModelSpending).mockResolvedValue(spending(100, 40, 1));
  mount();
  const link = await screen.findByRole("link", { name: "Review reservations" });
  expect(link.getAttribute("href")).toBe("/admin/token-usage?budget=recovery");
  expect(screen.getByText("Unknown model usage blocks new turns")).toBeTruthy();
  expect(screen.getByText(/^\$40\.00 of \$100\.00 charged or held in .+ \(UTC\)\. Some reservations still need recovery\.$/)).toBeTruthy();
});

it("shows a retry and no budget state after the budget check fails", async () => {
  vi.mocked(getModelSpending).mockRejectedValueOnce(new Error("Network failed")).mockResolvedValueOnce(spending(0, 0));
  vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: null }));
  vi.mocked(getAdminModelCatalog).mockResolvedValue({ providers: [{ id: "openai", label: "OpenAI", keySource: "tenant" }], models: [{ id: "openai/test", displayName: "Test", description: "", isDefault: false, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }] });
  mount();
  expect(await screen.findByText("Could not check the model budget.", { selector: "li p" })).toBeTruthy();
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry budget check" }));
  expect(await screen.findByText("New turns are paused")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Change budget" }).getAttribute("href")).toBe("/admin/token-usage?budget=edit");
});

it("summarizes Monitor evidence and leads into the enforcement review", async () => {
  mount();
  // The scheduled approval is a denial, not a request.
  expect(await screen.findByText("Monitor mode. In the last 7 days, 6 tool calls would have been blocked or needed approval under Enforce.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review enforcement" }).getAttribute("href")).toBe("/admin/policy?review=enforcement");
});

it("does not describe zero Monitor records as safety", async () => {
  vi.mocked(getPolicyMonitorSummary).mockResolvedValue({ ...monitorSummary(), rules: [],
    totals: { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 } });
  mount();
  const line = await screen.findByText("Monitor mode. No block or approval records counted in the last 7 days.");
  expect(line.textContent).not.toMatch(/matched|safe/);
});

it("does not load Monitor evidence or offer the review in Enforce", async () => {
  vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "enforce" }));
  mount();
  expect(await screen.findByText(/^Enforce mode\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Manage policies" }).getAttribute("href")).toBe("/admin/policy");
  expect(getPolicyMonitorSummary).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Review enforcement" })).toBeNull();
});

it("offers a retry when Monitor evidence fails to load", async () => {
  vi.mocked(getPolicyMonitorSummary).mockRejectedValueOnce(new Error("offline"));
  mount();
  expect(await screen.findByText("Monitor mode. Could not load the last 7 days.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry evidence" }));
  expect(await screen.findByText(/6 tool calls would have been blocked/)).toBeTruthy();
});

it("labels cached Monitor evidence after a failed refresh and offers a retry", async () => {
  const client = mount();
  expect(await screen.findByText(/6 tool calls would have been blocked/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry evidence" })).toBeNull();
  vi.mocked(getPolicyMonitorSummary).mockRejectedValueOnce(new Error("offline"));
  await act(() => client.refetchQueries({ queryKey: queryKeys.admin.policyMonitorSummary() }));
  expect(await screen.findByText(/Could not refresh\. These counts are from an earlier read\./)).toBeTruthy();
  expect(screen.getByText(/6 tool calls would have been blocked/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry evidence" }));
  await waitFor(() => expect(screen.queryByText(/Could not refresh/)).toBeNull());
  expect(screen.queryByRole("button", { name: "Retry evidence" })).toBeNull();
});

it("counts failed sessions and says when more exist", async () => {
  vi.mocked(listAdminSessions).mockResolvedValue({ items: [{ sessionId: "s1", userId: "u1" }], nextCursor: "next" } as never);
  mount();
  expect(await screen.findByText("1+ sessions have errors.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View failures" }).getAttribute("href")).toBe("/admin/sessions?status=errored");
});
