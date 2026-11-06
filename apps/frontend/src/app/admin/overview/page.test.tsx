// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminModelCatalogResponse, OrganizationSkillSubmission } from "@cogniplane/shared-types";
import AdminOverviewPage from "./page";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import { getAdminModelCatalog, getPolicyMonitorSummary, getTenantSettings, listAdminMcpServers, listAdminSkills, listAdminSessions } from "../../../lib/admin-api";
import { listAdminSkillSubmissions } from "../../../lib/organization-skill-submissions-api";
import { getModelSpending } from "../../../lib/model-spending-api";
import { useAuth } from "../../../lib/auth-context";
import { queryKeys } from "../../../lib/query-keys";
import { useModelSpending, useUtcMonth } from "../../../hooks/use-model-spending";

vi.mock("../../../lib/admin-api", () => ({ getAdminModelCatalog: vi.fn(), getPolicyMonitorSummary: vi.fn(), getTenantSettings: vi.fn(), listAdminMcpServers: vi.fn(), listAdminSkills: vi.fn(), listAdminSessions: vi.fn() }));
vi.mock("../../../lib/organization-skill-submissions-api", () => ({ listAdminSkillSubmissions: vi.fn() }));
vi.mock("../../../lib/model-spending-api", () => ({ getModelSpending: vi.fn() }));
vi.mock("../../../lib/auth-context", () => ({ useAuth: vi.fn() }));
const scope = { tenantId: "tenant-one", userId: "admin-one" };
const configuredCatalog: AdminModelCatalogResponse = {
  providers: [{ id: "openai", label: "OpenAI", keySource: "tenant" }, { id: "anthropic", label: "Anthropic", keySource: "none" }],
  models: [
    { id: "openai/one", displayName: "One", description: "", isDefault: false, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 },
    { id: "openai/two", displayName: "Two", description: "", isDefault: false, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 },
    { id: "anthropic/one", displayName: "Other", description: "", isDefault: false, provider: "anthropic", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }
  ]
};
const verificationLimit = "Key validity and model access are not verified.";

function submission(): OrganizationSkillSubmission {
  return { id: "11111111-1111-4111-8111-111111111111", version: 1, status: "pending", authorUserId: "author-one", authorName: "Ada Lovelace", authorEmail: "ada@example.test",
    sourceSkillId: "personal-skill-one", targetOrganizationSkillId: null, acceptedOrganizationSkillId: null,
    latest: { attempt: 1, status: "pending", note: "", snapshot: { content: { name: "research-brief", description: "A brief", instructions: "Do research" }, sourceRevision: 1, contentHash: "a".repeat(64), validationMessages: [] }, submittedAt: "2026-09-22T00:00:00Z", decidedAt: null, decidedBy: null, decidedByName: null, feedback: null, acceptedRevisionId: null },
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" };
}

vi.mock("../../../lib/admin-history-api", () => ({ listAdminHistory: async () => ({ items: [], nextCursor: null }) }));

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { ...scope, email: "admin@example.test", displayName: "Admin", role: "admin" }, accessToken: null, isLoading: false, login: vi.fn(), logout: vi.fn(), refreshToken: vi.fn(), completeLogin: vi.fn(), adoptSession: vi.fn() });
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
function mount(extra?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminOverviewPage />{extra}</QueryClientProvider>);
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
  expect(screen.getByText(`1 enabled model has a provider key. ${verificationLimit}`)).toBeTruthy();
});

it.each([
  { name: "one selected model", enabledProviders: ["openai"], enabledModelIds: ["openai/one"], keySource: "tenant", count: 1 },
  { name: "all models with tenant keys", enabledProviders: ["openai", "anthropic"], enabledModelIds: null, keySource: "tenant", count: 2 },
  { name: "all models with platform keys", enabledProviders: ["openai"], enabledModelIds: null, keySource: "platform", count: 2 },
  { name: "no model selection", enabledProviders: ["openai"], enabledModelIds: [], keySource: "tenant", count: 0 },
  { name: "disabled provider", enabledProviders: [], enabledModelIds: null, keySource: "tenant", count: 0 },
  { name: "no provider key", enabledProviders: ["openai"], enabledModelIds: null, keySource: "none", count: 0 }
] as const)("reports configuration only for $name", async ({ enabledProviders, enabledModelIds, keySource, count }) => {
  vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ enabledProviders: [...enabledProviders], enabledModelIds: enabledModelIds === null ? null : [...enabledModelIds] }));
  vi.mocked(getAdminModelCatalog).mockResolvedValue({ ...configuredCatalog, providers: [{ id: "openai", label: "OpenAI", keySource }, configuredCatalog.providers[1]!] });
  mount();
  const presence = count === 1 ? "1 enabled model has a provider key" : `${count} enabled models have provider keys`;
  expect(await screen.findByText(`${presence}. ${verificationLimit}`)).toBeTruthy();
  expect(screen.queryByText(/ready to use/i)).toBeNull();
  expect(screen.getByRole("link", { name: "Manage models" }).getAttribute("href")).toBe("/admin/models");
  if (count === 0) expect(screen.getByRole("link", { name: "Set up models" }).getAttribute("href")).toBe("/admin/models");
  if (keySource === "none") expect(screen.getByRole("link", { name: "Add API key" }).getAttribute("href")).toBe("/admin/models?provider=openai");
});

it.each(["catalog", "settings"] as const)("waits for the %s before reporting model configuration", async (check) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const settings = makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: null });
  vi.mocked(getTenantSettings).mockResolvedValue(settings);
  vi.mocked(getAdminModelCatalog).mockResolvedValue(configuredCatalog);
  if (check === "catalog") vi.mocked(getAdminModelCatalog).mockImplementationOnce(async () => { await pending; return configuredCatalog; });
  else vi.mocked(getTenantSettings).mockImplementationOnce(async () => { await pending; return settings; });
  mount();
  expect(await screen.findByText("Checking model configuration...")).toBeTruthy();
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();
  await act(async () => finish());
  expect(await screen.findByText(`2 enabled models have provider keys. ${verificationLimit}`)).toBeTruthy();
});

it.each(["catalog", "settings"] as const)("reports a failed %s even while the other model check is pending", async (check) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  if (check === "catalog") {
    vi.mocked(getAdminModelCatalog).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getTenantSettings).mockImplementationOnce(async () => { await pending; return makeTenantSettings(); });
  } else {
    vi.mocked(getTenantSettings).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getAdminModelCatalog).mockImplementationOnce(async () => { await pending; return configuredCatalog; });
  }
  mount();
  expect(await screen.findByText("Could not check model configuration.")).toBeTruthy();
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();
  expect(screen.getByRole("button", { name: check === "catalog" ? "Retry models" : "Retry organization settings" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Manage models" }).getAttribute("href")).toBe("/admin/models");
  await act(async () => finish());
  expect(screen.getByText("Could not check model configuration.")).toBeTruthy();
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();
});

it.each(["catalog", "settings"] as const)("hides cached model counts during a %s refresh, failure, and retry", async (check) => {
  const settings = makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: null });
  vi.mocked(getTenantSettings).mockResolvedValue(settings);
  vi.mocked(getAdminModelCatalog).mockResolvedValue(configuredCatalog);
  const client = mount();
  await screen.findByText(`2 enabled models have provider keys. ${verificationLimit}`);
  let reject!: (error: Error) => void;
  const refresh = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  if (check === "catalog") vi.mocked(getAdminModelCatalog).mockReturnValueOnce(refresh);
  else vi.mocked(getTenantSettings).mockReturnValueOnce(refresh);
  const queryKey = check === "catalog" ? queryKeys.models.adminCatalog() : queryKeys.admin.tenantSettings();
  let refreshDone!: Promise<void>;
  act(() => { refreshDone = client.refetchQueries({ queryKey }); });
  await screen.findByText("Checking model configuration...");
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();
  await act(async () => { reject(new Error("offline")); await refreshDone; });
  await screen.findByText("Could not check model configuration.");
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();

  let finish!: () => void;
  const retry = new Promise<void>(resolve => { finish = resolve; });
  if (check === "catalog") vi.mocked(getAdminModelCatalog).mockImplementationOnce(async () => { await retry; return { ...configuredCatalog, providers: [] }; });
  else vi.mocked(getTenantSettings).mockImplementationOnce(async () => { await retry; return { ...settings, enabledModelIds: [] }; });
  fireEvent.click(screen.getByRole("button", { name: check === "catalog" ? "Retry models" : "Retry organization settings" }));
  await screen.findByText(check === "catalog" ? "Checking models again..." : "Checking organization settings again...");
  expect(screen.getByText("Could not check model configuration.")).toBeTruthy();
  expect(screen.queryByText(/enabled models? (has|have)/)).toBeNull();
  await act(async () => finish());
  expect(await screen.findByText(`0 enabled models have provider keys. ${verificationLimit}`)).toBeTruthy();
  expect(screen.queryByText("Could not check model configuration.")).toBeNull();
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

it("keeps a failed check visible during a held retry and returns keyboard focus after recovery", async () => {
  let finish!: (value: { scope: typeof scope; submissions: OrganizationSkillSubmission[] }) => void;
  vi.mocked(listAdminSkillSubmissions).mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry skill submissions" });
  retry.focus();
  fireEvent.click(retry);
  await screen.findByText("Checking skill submissions again...");
  expect(screen.getByRole("button", { name: "Retrying..." }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Retrying..." }));
  expect(document.activeElement).toBe(retry);
  expect(screen.queryByText("Nothing needs attention.")).toBeNull();
  expect(listAdminSkillSubmissions).toHaveBeenCalledTimes(2);
  await act(async () => finish({ scope, submissions: [submission()] }));
  await screen.findByRole("link", { name: "Review submission" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Needs attention" })));
});

it("keeps the retry available after another failure and does not move focus away from another control", async () => {
  let finish!: (value: { scope: typeof scope; submissions: OrganizationSkillSubmission[] }) => void;
  vi.mocked(listAdminSkillSubmissions).mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("still offline"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry skill submissions" }));
  const retry = await screen.findByRole("button", { name: "Retry skill submissions" });
  retry.focus();
  fireEvent.click(retry);
  await screen.findByText("Checking skill submissions again...");
  const models = screen.getByRole("link", { name: "Manage models" });
  models.focus();
  await act(async () => finish({ scope, submissions: [] }));
  await waitFor(() => expect(screen.queryByText("Checking skill submissions again...")).toBeNull());
  expect(document.activeElement).toBe(models);
});


it("keeps the budget summary after a failed next page and during its held retry", async () => {
  let finish!: (value: ReturnType<typeof spending>) => void;
  vi.mocked(getModelSpending).mockResolvedValueOnce({ ...spending(null, 0), nextCursor: "next" })
    .mockRejectedValueOnce(new Error("page unavailable"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  function BudgetPagination() {
    const budget = useModelSpending(useUtcMonth());
    return <button onClick={() => void budget.fetchNextPage()}>Load next budget page</button>;
  }
  mount(<BudgetPagination />);
  await screen.findByText("No monthly limit.");
  fireEvent.click(screen.getByRole("button", { name: "Load next budget page" }));
  await waitFor(() => expect(getModelSpending).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Could not check the model budget.")).toBeNull();
  expect(screen.getByText("No monthly limit.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load next budget page" }));
  await waitFor(() => expect(getModelSpending).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("Checking the model budget again...")).toBeNull();
  expect(screen.getByText("No monthly limit.")).toBeTruthy();
  await act(async () => finish(spending(null, 0)));
});
