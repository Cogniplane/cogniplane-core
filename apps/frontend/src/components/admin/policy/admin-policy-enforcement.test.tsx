// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyMonitorSummaryResponse } from "@cogniplane/shared-types";
import { AdminPolicyEnforcement } from "./admin-policy-enforcement";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import { getPolicyMonitorSummary, getTenantSettings, updateTenantAgentSettings } from "../../../lib/admin-api";
import { ApiError } from "../../../lib/api-client";

vi.mock("../../../lib/admin-api", () => ({
  getTenantSettings: vi.fn(),
  updateTenantAgentSettings: vi.fn(),
  getPolicyMonitorSummary: vi.fn()
}));
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => "/admin/policy",
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() })
}));

const zero = { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 };
function summary(overrides: Partial<PolicyMonitorSummaryResponse> = {}): PolicyMonitorSummaryResponse {
  return {
    windowStart: "2026-09-20T12:00:00.000Z",
    windowEnd: "2026-09-27T12:00:00.000Z",
    totals: { block: 3, approvalInteractive: 2, approvalScheduled: 1, approvalUnknownContext: 1, total: 7 },
    rules: [
      {
        ruleId: "pol_writes",
        currentRule: { name: "Block GitHub writes", enabled: true, effect: "block" },
        counts: { block: 3, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 3 },
        lastRecordedAt: "2026-09-26T10:00:00.000Z"
      },
      {
        ruleId: "pol_gone",
        currentRule: null,
        counts: { block: 0, approvalInteractive: 2, approvalScheduled: 1, approvalUnknownContext: 1, total: 4 },
        lastRecordedAt: "2026-09-25T10:00:00.000Z"
      }
    ],
    excluded: { resourceChecks: 4, unrecognized: 2 },
    ...overrides
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  navigation.search = "";
  vi.mocked(getPolicyMonitorSummary).mockResolvedValue(summary());
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminPolicyEnforcement /></QueryClientProvider>);
  return client;
}

async function openReview() {
  fireEvent.click(await screen.findByRole("button", { name: "Review enforcement" }));
  return screen.findByRole("dialog", { name: "Enable enforcement" });
}

describe("policy enforcement in Monitor", () => {
  it("sums the last 7 days in the mode row and keeps the per-rule detail for the review", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    mount();
    // Scheduled approvals are denials, so they stay apart from the calls that would ask.
    expect(await screen.findByText(/In the last 7 days, Enforce would have blocked 3 tool calls, asked for approval on 3 tool calls and denied 1 scheduled tool call\./)).toBeTruthy();
    expect(screen.getByText(/Rules do not block tool calls or ask for approval\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Monitor is active" })).toBeTruthy();
    expect(screen.queryByText("Deleted rule")).toBeNull();
    const dialog = await openReview();
    expect(await within(dialog).findByText("Deleted rule")).toBeTruthy();
    expect(within(dialog).getByText("Deleted. It will not act under Enforce.")).toBeTruthy();
    expect(within(dialog).getByText(/resource checks after a tool call finished \(4\).*older or unrecognized records \(2\)/)).toBeTruthy();
    expect(screen.queryByLabelText("Policy enforcement mode")).toBeNull();
  });

  it("does not present zero records as proof that enforcement is safe", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    vi.mocked(getPolicyMonitorSummary).mockResolvedValue(summary({ totals: zero, rules: [] }));
    mount();
    expect(await screen.findByText(/No block or approval records counted in the last 7 days\. That does not prove Enforce is safe\./)).toBeTruthy();
    expect(screen.queryByText(/No rule matched/)).toBeNull();
    const dialog = await openReview();
    expect(await within(dialog).findByText(/does not mean that no tool calls ran or that Enforce is safe/)).toBeTruthy();
  });

  it("labels numbers from an earlier read after a failed refresh and retries them", async () => {
    let finishRetry!: (value: PolicyMonitorSummaryResponse) => void;
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    vi.mocked(getPolicyMonitorSummary)
      .mockResolvedValueOnce(summary())
      .mockRejectedValueOnce(new Error("Evidence offline"))
      .mockReturnValueOnce(new Promise((resolve) => { finishRetry = resolve; }));
    const client = mount();
    await screen.findByText(/blocked 3 tool calls/);
    expect(screen.queryByRole("button", { name: "Retry evidence" })).toBeNull();
    await client.refetchQueries({ queryKey: ["admin"] }).catch(() => undefined);
    expect((await screen.findByRole("alert")).textContent).toContain("from the last successful read");
    expect(screen.getByText(/blocked 3 tool calls/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry evidence" });
    fireEvent.click(retry);
    // The button stays while it retries, so focus is not lost.
    expect(await screen.findByRole("button", { name: "Retrying..." })).toBe(retry);
    finishRetry(summary({ totals: { ...zero, block: 11, total: 11 } }));
    expect(await screen.findByText(/blocked 11 tool calls/)).toBeTruthy();
    expect(screen.queryByText(/from the last successful read/)).toBeNull();
  });

  it("does not predict fewer actions when listed rules are disabled or deleted", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    const warning = await within(dialog).findByText(/1 rule in this list is now disabled or deleted/);
    expect(warning.textContent).toContain("Other rules can match the same tool calls");
    expect(warning.textContent).not.toMatch(/fewer/);
  });

  it("reviews fresh evidence, then enables with the reviewed settings version", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }));
    let finishRead!: (value: PolicyMonitorSummaryResponse) => void;
    vi.mocked(getPolicyMonitorSummary)
      .mockResolvedValueOnce(summary())
      .mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    vi.mocked(updateTenantAgentSettings).mockResolvedValue(makeTenantSettings({ version: 8, policyEnforcementMode: "enforce" }));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    const enable = within(dialog).getByRole("button", { name: "Enable enforcement" });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole("status", { name: "Reading the latest evidence and settings" })).toBeTruthy();
    finishRead(summary({ totals: { ...zero, block: 9, total: 9 } }));
    // The review shows the second read, not the cached numbers on the page.
    expect(await within(dialog).findByText("tool calls would have been blocked.")).toBeTruthy();
    expect(within(dialog).getByText("9")).toBeTruthy();
    expect(getTenantSettings).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText(/uses organization settings v7/)).toBeTruthy();
    // The safe action has focus first.
    expect(document.activeElement?.textContent).toBe("Keep Monitor");
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(enable);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(vi.mocked(updateTenantAgentSettings).mock.calls[0]?.[0]).toEqual({ expectedVersion: 7, policyEnforcementMode: "enforce" });
    expect(await screen.findByText(/Enforce is on\. It applies from the next turn/)).toBeTruthy();
    expect(screen.getByText(/Turns already running keep their current mode\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Enforce is active" })).toBeTruthy();
    expect(screen.queryByText(/In the last 7 days/)).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
  });

  it("keeps Enable off while the evidence cannot be read", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    vi.mocked(getPolicyMonitorSummary).mockResolvedValueOnce(summary()).mockRejectedValueOnce(new Error("Evidence offline"));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    expect(await within(dialog).findByText("Evidence offline")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Enable enforcement" }) as HTMLButtonElement).disabled).toBe(true);
    // The page does not know the current mode, so the close action claims no mode.
    expect(within(dialog).getByText("The review cannot continue until both reads succeed.")).toBeTruthy();
    expect(within(dialog).queryByText(/Enforcement stays off/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Back to policies" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Keep Monitor" })).toBeNull();
    vi.mocked(getPolicyMonitorSummary).mockResolvedValueOnce(summary());
    fireEvent.click(within(dialog).getByRole("button", { name: "Read again" }));
    await waitFor(() =>
      expect((within(dialog).getByRole("button", { name: "Enable enforcement" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect(updateTenantAgentSettings).not.toHaveBeenCalled();
  });

  it("asks for a new review after a conflict instead of overwriting newer settings", async () => {
    vi.mocked(getTenantSettings)
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockResolvedValue(makeTenantSettings({ version: 9, policyEnforcementMode: "monitor" }));
    vi.mocked(updateTenantAgentSettings)
      .mockRejectedValueOnce(new ApiError({ status: 409, method: "PUT", path: "/admin/tenant-settings", message: "Settings changed" }))
      .mockResolvedValue(makeTenantSettings({ version: 10, policyEnforcementMode: "enforce" }));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    const enable = within(dialog).getByRole("button", { name: "Enable enforcement" });
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(enable);
    expect(await within(dialog).findByText(/changed to v9 after this review opened \(v7\)/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Enable enforcement" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review again" }));
    expect(await within(dialog).findByText(/uses organization settings v9/)).toBeTruthy();
    const again = within(dialog).getByRole("button", { name: "Enable enforcement" });
    await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(updateTenantAgentSettings).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateTenantAgentSettings).mock.calls[1]?.[0]).toEqual({ expectedVersion: 9, policyEnforcementMode: "enforce" });
  });

  it("does not say nothing was saved when the response fails after the save", async () => {
    vi.mocked(getTenantSettings)
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockResolvedValue(makeTenantSettings({ version: 8, policyEnforcementMode: "enforce" }));
    vi.mocked(updateTenantAgentSettings).mockRejectedValue(
      new ApiError({ status: 500, method: "PUT", path: "/admin/tenant-settings", message: "Audit write failed" })
    );
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    const enable = within(dialog).getByRole("button", { name: "Enable enforcement" });
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(enable);
    expect(await within(dialog).findByText("Enforce is on.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Enable enforcement|Try again/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Enforce is on\. It applies from the next turn/)).toBeTruthy();
    expect(updateTenantAgentSettings).toHaveBeenCalledTimes(1);
  });

  it("requires the current settings before a retry when the reload fails", async () => {
    vi.mocked(getTenantSettings)
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockResolvedValueOnce(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }))
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValue(makeTenantSettings({ version: 7, policyEnforcementMode: "monitor" }));
    vi.mocked(updateTenantAgentSettings).mockRejectedValue(new Error("Network down"));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    const enable = within(dialog).getByRole("button", { name: "Enable enforcement" });
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(enable);
    expect(await within(dialog).findByText("Could not load the current settings.")).toBeTruthy();
    expect(within(dialog).getByText("Could not confirm the save.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Enable enforcement" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Back to policies" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Load current settings" }));
    const retry = await within(dialog).findByRole("button", { name: "Try again" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it("returns focus to the review button when the review closes", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    mount();
    await screen.findByText(/In the last 7 days/);
    const dialog = await openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep Monitor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Review enforcement"));
    expect(updateTenantAgentSettings).not.toHaveBeenCalled();
  });

  it("opens the review from the Overview link and drops the parameter", async () => {
    navigation.search = "review=enforcement&rule=pol_writes";
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ policyEnforcementMode: "monitor" }));
    mount();
    expect(await screen.findByRole("dialog", { name: "Enable enforcement" })).toBeTruthy();
    expect(navigation.replace).toHaveBeenCalledWith("/admin/policy?rule=pol_writes", { scroll: false });
  });
});

describe("policy enforcement in Enforce", () => {
  it("switches back to Monitor with the loaded version", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ version: 4, policyEnforcementMode: "enforce" }));
    vi.mocked(updateTenantAgentSettings).mockResolvedValue(makeTenantSettings({ version: 5, policyEnforcementMode: "monitor" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Monitor" }));
    expect(await screen.findByText(/Monitor is on\. Rules stop blocking/)).toBeTruthy();
    expect(vi.mocked(updateTenantAgentSettings).mock.calls[0]?.[0]).toEqual({ expectedVersion: 4, policyEnforcementMode: "monitor" });
    expect(screen.getByRole("heading", { name: "Monitor is active" })).toBeTruthy();
    expect(getPolicyMonitorSummary).toHaveBeenCalled();
  });

  it("reports the current mode after an unconfirmed switch", async () => {
    vi.mocked(getTenantSettings).mockResolvedValue(makeTenantSettings({ version: 4, policyEnforcementMode: "enforce" }));
    vi.mocked(updateTenantAgentSettings).mockRejectedValue(new Error("Timeout"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Monitor" }));
    expect(await screen.findByText(/did not confirm the switch.*the mode is Enforce/)).toBeTruthy();
    expect(getTenantSettings).toHaveBeenCalledTimes(2);
    expect(getPolicyMonitorSummary).not.toHaveBeenCalled();
  });

  it("blocks another switch until the current settings load after an unconfirmed switch", async () => {
    vi.mocked(getTenantSettings)
      .mockResolvedValueOnce(makeTenantSettings({ version: 4, policyEnforcementMode: "enforce" }))
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValue(makeTenantSettings({ version: 4, policyEnforcementMode: "enforce" }));
    vi.mocked(updateTenantAgentSettings).mockRejectedValue(new Error("Timeout"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Monitor" }));
    expect(await screen.findByText(/did not confirm the switch to Monitor\. The change can be saved/)).toBeTruthy();
    const switchButton = screen.getByRole("button", { name: "Switch to Monitor" }) as HTMLButtonElement;
    await waitFor(() => expect(switchButton.disabled).toBe(true));
    expect(screen.getByText(/The mode shown can be out of date/)).toBeTruthy();
    fireEvent.click(switchButton);
    expect(updateTenantAgentSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Load current settings" }));
    await waitFor(() => expect(switchButton.disabled).toBe(false));
    expect(screen.queryByText(/The mode shown can be out of date/)).toBeNull();
    expect(getTenantSettings).toHaveBeenCalledTimes(3);
  });

  it("shows loading, then offers a retry when settings fail to load", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(getTenantSettings).mockReturnValueOnce(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    mount();
    expect(screen.getByText("Loading policy enforcement...")).toBeTruthy();
    reject(new Error("Settings unavailable"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry settings" }));
    await waitFor(() => expect(getTenantSettings).toHaveBeenCalledTimes(2));
  });
});
