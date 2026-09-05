// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchTokenUsage: vi.fn(),
  fetchPersonalTokenUsage: vi.fn(),
  fetchMessageFeedback: vi.fn()
}));

vi.mock("../lib/token-usage-api", () => ({ fetchTokenUsage: api.fetchTokenUsage }));
vi.mock("../lib/settings-api", () => ({ fetchPersonalTokenUsage: api.fetchPersonalTokenUsage }));
vi.mock("../lib/message-feedback-api", () => ({ fetchMessageFeedback: api.fetchMessageFeedback }));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    Bar: () => null,
    BarChart: ({ children, data }: { children: ReactElement; data: Array<{ label: string }> }) => (
      <div data-testid="bar-chart">
        {data.map((row) => row.label).join(",")}
        {children}
      </div>
    ),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null
  };
});

import { MessageFeedbackSection } from "./message-feedback-section";
import { PersonalTokenUsageSection } from "./personal-token-usage-section";
import { TokenUsageSection } from "./token-usage-section";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function usage(totalTokens: number) {
  return {
    daily: [],
    byUser: [],
    byModel: [],
    totals: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens, costUsd: 0.25, messageCount: 2 }
  };
}

function feedback(total: number) {
  return {
    totals: { thumbsUp: total, thumbsDown: 0, total, ratePercent: total ? 100 : null },
    daily: [],
    byModel: []
  };
}

function renderWithQuery(ui: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe.each([
  ["admin token usage", TokenUsageSection, api.fetchTokenUsage, usage],
  ["personal token usage", PersonalTokenUsageSection, api.fetchPersonalTokenUsage, usage],
  ["message feedback", MessageFeedbackSection, api.fetchMessageFeedback, feedback]
] as const)("%s range queries", (_name, Component, fetcher, makeResult) => {
  it("keeps the selected range when an older request resolves last", async () => {
    const first = deferred<ReturnType<typeof makeResult>>();
    const second = deferred<ReturnType<typeof makeResult>>();
    fetcher.mockImplementation((days: number) => days === 30 ? first.promise : second.promise);
    renderWithQuery(<Component />);

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await act(async () => second.resolve(makeResult(7)));
    await waitFor(() => expect(screen.getByText("7")).toBeTruthy());
    await act(async () => first.resolve(makeResult(30)));
    expect(screen.queryByText("30")).toBeNull();
  });

  it("keeps the previous summary while the next range is pending", async () => {
    const first = deferred<ReturnType<typeof makeResult>>();
    const second = deferred<ReturnType<typeof makeResult>>();
    fetcher.mockImplementation((days: number) => (days === 30 ? first.promise : second.promise));
    renderWithQuery(<Component />);

    await act(async () => first.resolve(makeResult(30)));
    await waitFor(() => expect(screen.getByText("30")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => second.resolve(makeResult(7)));
    await waitFor(() => expect(screen.getByText("7")).toBeTruthy());
  });
});

describe("token report presentation", () => {
  it("uses the same summary and loading skeleton for admin and personal reports", async () => {
    const admin = deferred<ReturnType<typeof usage>>();
    const personal = deferred<ReturnType<typeof usage>>();
    api.fetchTokenUsage.mockReturnValue(admin.promise);
    api.fetchPersonalTokenUsage.mockReturnValue(personal.promise);
    const adminView = renderWithQuery(<TokenUsageSection />);
    expect(screen.getAllByTestId("token-usage-stat-skeleton")).toHaveLength(4);
    await act(async () => admin.resolve(usage(1_500)));
    await screen.findAllByText("1.5k");
    expect(screen.getByText("In the last 30 days")).toBeTruthy();
    adminView.unmount();

    renderWithQuery(<PersonalTokenUsageSection />);
    expect(screen.getAllByTestId("token-usage-stat-skeleton")).toHaveLength(4);
    await act(async () => personal.resolve(usage(1_500)));
    await screen.findAllByText("1.5k");
    expect(screen.getByText("In the last 30 days")).toBeTruthy();
  });

  it("recovers from a personal report error on another range and renders zero data", async () => {
    api.fetchPersonalTokenUsage.mockImplementation(async (days: number) => {
      if (days === 30) throw new Error("usage failed");
      return usage(0);
    });
    renderWithQuery(<PersonalTokenUsageSection />);
    await screen.findByText("usage failed");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByText("No token data recorded in this period.");
    expect(screen.queryByText("usage failed")).toBeNull();
  });

  it("preserves admin unavailable handling and recovers after a remount", async () => {
    api.fetchTokenUsage.mockRejectedValueOnce(new Error("Route GET:/admin/token-usage not found")).mockResolvedValueOnce(usage(4));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const first = renderWithQuery(<TokenUsageSection />, client);
    await screen.findByText("Token usage reporting is not available on this deployment yet.");
    expect(screen.queryByRole("button", { name: "30d" })).toBeNull();
    first.unmount();
    renderWithQuery(<TokenUsageSection />, client);
    await screen.findByText("4");
    expect(screen.getByRole("button", { name: "30d" })).toBeTruthy();
  });

  it("keeps the admin-only user breakdown", async () => {
    api.fetchTokenUsage.mockResolvedValue({
      ...usage(9),
      byUser: [{ userId: "user-1234567890", inputTokens: 6, outputTokens: 3, totalTokens: 9, costUsd: 0.25 }]
    });
    renderWithQuery(<TokenUsageSection />);
    await screen.findByText("9");
    fireEvent.click(screen.getByRole("button", { name: "By user" }));
    expect(screen.getByText("User")).toBeTruthy();
    expect(screen.getAllByText("user-1…7890")).toHaveLength(2);
  });

  it("renders admin daily and model breakdowns", async () => {
    api.fetchTokenUsage.mockResolvedValue({
      ...usage(12),
      daily: [{ date: "2026-09-03", inputTokens: 8, outputTokens: 4, totalTokens: 12, costUsd: 0.25 }],
      byModel: [{ modelName: "admin-model", inputTokens: 8, outputTokens: 4, totalTokens: 12, costUsd: 0.25 }]
    });
    renderWithQuery(<TokenUsageSection />);
    await screen.findByText("2026-09-03");
    fireEvent.click(screen.getByRole("button", { name: "By model" }));
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getAllByText("admin-model")).toHaveLength(2);
  });

  it("keeps the personal model label and warning color", async () => {
    api.fetchPersonalTokenUsage.mockResolvedValue({
      ...usage(6),
      byModel: [{ modelName: "personal-model", inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0.1 }]
    });
    const view = renderWithQuery(<PersonalTokenUsageSection />);
    await screen.findByText("6");
    fireEvent.click(screen.getByRole("button", { name: "By model" }));
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getAllByText("personal-model")).toHaveLength(2);
    expect(view.container.querySelector('[style*="var(--color-warning)"]')).toBeTruthy();
  });
});

describe("message feedback states", () => {
  it("recovers from an error and renders the zero state", async () => {
    api.fetchMessageFeedback.mockImplementation(async (days: number) => {
      if (days === 30) throw new Error("feedback failed");
      return feedback(0);
    });
    renderWithQuery(<MessageFeedbackSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await screen.findByText("feedback failed");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByText("No feedback recorded in this period.");
    expect(screen.queryByText("feedback failed")).toBeNull();
  });

  it("preserves unavailable handling and recovers after a remount", async () => {
    api.fetchMessageFeedback.mockRejectedValueOnce(new Error("Route GET:/admin/message-feedback not found")).mockResolvedValueOnce(feedback(1));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const first = renderWithQuery(<MessageFeedbackSection />, client);
    await screen.findByText("Message feedback reporting is not available on this deployment yet.");
    first.unmount();
    renderWithQuery(<MessageFeedbackSection />, client);
    await screen.findByText("1 rated responses");
  });

  it("renders both breakdowns and sorts the daily table", async () => {
    api.fetchMessageFeedback.mockResolvedValue({
      totals: { thumbsUp: 2, thumbsDown: 1, total: 3, ratePercent: 67 },
      daily: [
        { date: "2026-09-02", thumbsUp: 1, thumbsDown: 1 },
        { date: "2026-09-01", thumbsUp: 1, thumbsDown: 0 }
      ],
      byModel: [{ modelName: "feedback-model", thumbsUp: 2, thumbsDown: 1, total: 3, ratePercent: 67 }]
    });
    renderWithQuery(<MessageFeedbackSection />);
    await screen.findByText("feedback-model");
    const dateButton = screen.getByRole("button", { name: /Date/ });
    fireEvent.click(dateButton);
    const dailyTable = dateButton.closest("table");
    expect(dailyTable).toBeTruthy();
    const rows = within(dailyTable!).getAllByRole("row");
    expect(rows[1]?.textContent).toContain("2026-09-01");
    fireEvent.click(dateButton);
    const sortedRows = within(dailyTable!).getAllByRole("row");
    expect(sortedRows[1]?.textContent).toContain("2026-09-02");
  });
});
