// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalTokenUsageSection } from "./personal-token-usage-section";
import { TokenUsageSection } from "./token-usage-section";
import { fetchPersonalTokenUsage } from "../lib/settings-api";
import { fetchTokenUsage } from "../lib/token-usage-api";
import { listAdminUsers } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";
import { DayRangePicker, TokenBreakdown, ViewToggle } from "./token-usage-chart-primitives";
import { MessageFeedbackSection } from "./message-feedback-section";
import { fetchMessageFeedback } from "../lib/message-feedback-api";

vi.mock("../lib/settings-api", () => ({ fetchPersonalTokenUsage: vi.fn() }));
vi.mock("../lib/token-usage-api", () => ({ fetchTokenUsage: vi.fn() }));
vi.mock("../lib/admin-api", () => ({ listAdminUsers: vi.fn() }));
vi.mock("../lib/message-feedback-api", () => ({ fetchMessageFeedback: vi.fn() }));

const clients: QueryClient[] = [];
const fullModel = "provider/model-with-a-complete-version-and-deployment-name-that-must-remain-readable";
const totals = { inputTokens: 12345, outputTokens: 6789, totalTokens: 19134, costUsd: 0.012345, messageCount: 11 };
const sample = { totals, daily: [], byModel: [{ modelName: fullModel, ...totals }], byUser: [{ userId: "complete-user-identity", ...totals }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
  return client;
}
beforeEach(() => vi.mocked(listAdminUsers).mockResolvedValue([]));
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });

for (const admin of [false, true]) {
  const fetchUsage = admin ? vi.mocked(fetchTokenUsage) : vi.mocked(fetchPersonalTokenUsage);
  const Component = admin ? TokenUsageSection : PersonalTokenUsageSection;
  describe(admin ? "organization usage" : "personal usage", () => {
    it("labels retained data by its response period and ignores a late response to another period", async () => {
      const seven = deferred<typeof sample>();
      const fourteen = deferred<typeof sample>();
      fetchUsage.mockImplementation(days => days === 7 ? seven.promise : days === 14 ? fourteen.promise : Promise.resolve(sample));
      mount(<Component />);
      await screen.findByText("In the last 30 days");
      fireEvent.click(screen.getByRole("button", { name: "By model" }));
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      expect(screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("status").textContent).toContain("Showing the previous 30-day report");
      expect(screen.getByText("In the last 30 days")).toBeTruthy();
      expect(screen.queryByText("In the last 7 days")).toBeNull();
      expect(screen.getByText(fullModel)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "14d" }));
      await act(async () => { seven.resolve({ ...sample, totals: { ...totals, totalTokens: 7 } }); });
      expect(screen.queryByText("In the last 7 days")).toBeNull();
      await act(async () => { fourteen.resolve({ ...sample, totals: { ...totals, totalTokens: 14 } }); });
      await screen.findByText("In the last 14 days");
      expect(screen.getByText("14")).toBeTruthy();
    });

    it("preserves a failed range read and recovers with Retry", async () => {
      const seven = deferred<typeof sample>();
      fetchUsage.mockImplementation(days => days === 7 ? seven.promise : Promise.resolve(sample));
      mount(<Component />);
      await screen.findByText("In the last 30 days");
      fireEvent.click(screen.getByRole("button", { name: "By model" }));
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      await act(async () => { seven.reject(new Error("Usage read failed.")); });
      expect((await screen.findByRole("alert")).textContent).toContain("30-day report shown below has not been updated");
      expect(screen.getByText(fullModel)).toBeTruthy();
      expect(screen.getByText("In the last 30 days")).toBeTruthy();
      fetchUsage.mockResolvedValue(sample);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("In the last 7 days");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("distinguishes initial loading, initial error, retry and successful zero data", async () => {
      const first = deferred<typeof sample>();
      fetchUsage.mockReturnValue(first.promise);
      mount(<Component />);
      expect(screen.getByRole("status").textContent).toBe("Loading usage for the last 30 days.");
      expect(screen.getAllByTestId("token-usage-stat-skeleton")).toHaveLength(4);
      await act(async () => { first.reject(new Error("Cannot read usage.")); });
      await screen.findByRole("alert");
      expect(screen.queryByText("No token data recorded in this period.")).toBeNull();
      fetchUsage.mockResolvedValue({ totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0 }, daily: [], byModel: [], byUser: [] });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("No token data recorded in this period.");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("$0.00")).toBeTruthy();
    });

    it("retains the same-period report after a background refresh fails", async () => {
      fetchUsage.mockResolvedValue(sample);
      const client = mount(<Component />);
      await screen.findByText("In the last 30 days");
      fetchUsage.mockRejectedValue(new Error("Refresh failed."));
      await act(async () => { await client.invalidateQueries({ queryKey: admin ? queryKeys.admin.tokenUsage(30) : queryKeys.settings.tokenUsage(30) }); });
      expect((await screen.findByRole("alert")).textContent).toContain("has not been updated");
      expect(screen.getByText("19,134")).toBeTruthy();
    });

    it("states when the route is unavailable and offers a safe read retry", async () => {
      fetchUsage.mockRejectedValue(new ApiError({ status: 404, code: "not_found", method: "GET", path: admin ? "/admin/token-usage?days=30" : "/me/token-usage?days=30", message: "not_found" }));
      mount(<Component />);
      expect((await screen.findByRole("alert")).textContent).toContain("not available on this deployment yet");
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      expect(screen.queryByText("$0.00")).toBeNull();
    });
  });
}

it("exposes every complete identity and all four exact values in labeled rows", () => {
  mount(<TokenBreakdown rows={[{ key: fullModel, label: fullModel, ...totals }]} firstColumnLabel="Model" barColor="var(--chart-1)" />);
  const list = screen.getByRole("list", { name: "Model token breakdown" });
  expect(within(list).getByText(fullModel).className).not.toContain("truncate");
  for (const value of ["Input", "12,345", "Output", "6,789", "Total", "19,134", "Est. cost, USD", "$0.0123"]) expect(within(list).getByText(value)).toBeTruthy();
});

it("keeps ordinary button interaction and exposes selected state in named groups", () => {
  const period = vi.fn(), view = vi.fn();
  mount(<><DayRangePicker value={30} onChange={period} /><ViewToggle value="day" options={[{ id: "day", label: "Over time" }, { id: "model", label: "By model" }]} onChange={view} /></>);
  expect(within(screen.getByRole("group", { name: "Report period" })).getByRole("button", { name: "30d", pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "7d" }));
  expect(period).toHaveBeenCalledWith(7);
  fireEvent.click(screen.getByRole("button", { name: "By model" }));
  expect(view).toHaveBeenCalledWith("model");
  expect(screen.queryByRole("tab")).toBeNull();
});

it("keeps Feedback period and view callers working with the shared selected buttons", async () => {
  vi.mocked(fetchMessageFeedback).mockResolvedValue({ totals: { total: 0, thumbsUp: 0, thumbsDown: 0, ratePercent: null }, daily: [], byModel: [] });
  mount(<MessageFeedbackSection />);
  await screen.findByText("No feedback recorded in the displayed 30-day report.");
  fireEvent.click(screen.getByRole("button", { name: "7d" }));
  await waitFor(() => expect(fetchMessageFeedback).toHaveBeenCalledWith(7));
  expect(screen.getByRole("button", { name: "7d", pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "By model" }));
  expect(screen.getByRole("button", { name: "By model", pressed: true })).toBeTruthy();
});

it("discloses the top-50 organization scope and lets names retry without replacing IDs", async () => {
  vi.mocked(fetchTokenUsage).mockResolvedValue(sample);
  vi.mocked(listAdminUsers).mockRejectedValue(new Error("Names unavailable"));
  mount(<TokenUsageSection />);
  fireEvent.click(screen.getByRole("button", { name: "By user" }));
  await screen.findByText("Names could not be loaded. Showing user IDs where needed.");
  expect(screen.getByText(/shows up to 50 users with the most tokens/)).toBeTruthy();
  expect(screen.getByText("complete-user-identity")).toBeTruthy();
  vi.mocked(listAdminUsers).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "Retry names" }));
  await waitFor(() => expect(listAdminUsers).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("Names could not be loaded. Showing user IDs where needed.")).toBeNull());
});
