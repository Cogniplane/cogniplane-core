// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageFeedbackStats } from "@cogniplane/shared-types";
import { MessageFeedbackSection } from "./message-feedback-section";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../lib/message-feedback-api", () => ({ fetchMessageFeedback: api.fetch }));
const summary = { thumbsUp: 3, thumbsDown: 1, total: 4, ratePercent: 75 };
const empty = { thumbsUp: 0, thumbsDown: 0, total: 0, ratePercent: null };
const stats: MessageFeedbackStats = {
  totals: summary,
  daily: [{ date: "2026-09-21", thumbsUp: 3, thumbsDown: 1 }],
  byModel: [
    { modelName: "Unrated", ...empty },
    { modelName: "Negative", thumbsUp: 0, thumbsDown: 2, total: 2, ratePercent: 0 },
    { modelName: "Mixed", ...summary },
    { modelName: "Positive", thumbsUp: 4, thumbsDown: 0, total: 4, ratePercent: 100 }
  ]
};
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><MessageFeedbackSection /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); api.fetch.mockResolvedValue(stats); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("shows totals and keeps the previous report visible while changing the period", async () => {
  let resolve!: (value: MessageFeedbackStats) => void;
  api.fetch.mockResolvedValueOnce(stats).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount();
  await screen.findByText("4 rated responses");
  expect(api.fetch).toHaveBeenCalledWith(30);
  fireEvent.click(screen.getByRole("button", { name: "7d" }));
  await screen.findByText("Loading…");
  expect(screen.getByText("4 rated responses")).toBeTruthy();
  expect(screen.queryByText("No feedback recorded in this period.")).toBeNull();
  await act(async () => resolve({ totals: empty, daily: [], byModel: [] }));
  await screen.findByText("No feedback recorded in this period.");
  expect(api.fetch).toHaveBeenLastCalledWith(7);
  expect(screen.queryByRole("table")).toBeNull();
});

it("sorts model rates in both directions with unrated models last", async () => {
  mount();
  await screen.findByText("4 rated responses");
  expect(screen.queryByText("Unrated")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "By model" }));
  await screen.findByText("Unrated");
  expect(screen.queryByText("Daily breakdown")).toBeNull();
  const table = screen.getByRole("table");
  const rate = within(table).getByRole("button", { name: "Rate" });
  const names = () => within(table).getAllByRole("row").slice(1)
    .map(row => within(row).getAllByRole("cell")[0].textContent);
  fireEvent.click(rate);
  expect(names()).toEqual(["Positive", "Mixed", "Negative", "Unrated"]);
  fireEvent.click(rate);
  expect(names()).toEqual(["Negative", "Mixed", "Positive", "Unrated"]);
  expect(within(table).getByText("0%")).toBeTruthy();
  expect(within(table).getByText("—")).toBeTruthy();
});

it("shows a request failure and can recover by selecting another period", async () => {
  api.fetch.mockRejectedValueOnce(new Error("Reporting unavailable"));
  mount();
  await screen.findByText("Reporting unavailable");
  expect(screen.queryByText("No feedback recorded in this period.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "7d" }));
  await screen.findByText("4 rated responses");
  expect(screen.queryByText("Reporting unavailable")).toBeNull();
});

it("explains an unavailable route without showing empty report controls", async () => {
  api.fetch.mockRejectedValue(new Error("Route GET:/admin/message-feedback?days=30 not found"));
  mount();
  await screen.findByText("Message feedback reporting is not available on this deployment yet.");
  expect(screen.queryByRole("button", { name: "7d" })).toBeNull();
  expect(screen.queryByText("No feedback recorded in this period.")).toBeNull();
});
