// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TokenUsageSection } from "./token-usage-section";
import { listAdminUsers } from "../lib/admin-api";
import { fetchTokenUsage } from "../lib/token-usage-api";

vi.mock("../lib/admin-api", () => ({ listAdminUsers: vi.fn() }));
vi.mock("../lib/token-usage-api", () => ({ fetchTokenUsage: vi.fn() }));
vi.mock("./token-usage-chart-primitives", async (original) => ({
  ...await original<typeof import("./token-usage-chart-primitives")>(),
  BarChart: () => <div>Usage chart</div>
}));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.resetAllMocks(); });
function mount() {
  const totals = { inputTokens: 100, outputTokens: 25, totalTokens: 125, costUsd: 0.01, messageCount: 1 };
  vi.mocked(fetchTokenUsage).mockResolvedValue({ totals, daily: [], byModel: [], byUser: [{ userId: "user-long-stable-id", ...totals }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TokenUsageSection /></QueryClientProvider>);
}
it("loads permitted user names only for the user report", async () => {
  vi.mocked(listAdminUsers).mockResolvedValue([{
    userId: "user-long-stable-id", tenantId: "tenant", email: "mathieu@example.test", displayName: "Mathieu",
    role: "member", isBetaTester: false, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z"
  }]);
  mount();
  await screen.findByText("No token data recorded in this period.");
  expect(listAdminUsers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "By user" }));
  expect((await screen.findAllByText("Mathieu (mathieu@example.test)")).length).toBeGreaterThan(0);
});
it("keeps usage visible with the full user ID when directory loading fails", async () => {
  vi.mocked(listAdminUsers).mockRejectedValue(new Error("Unavailable"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "By user" }));
  await screen.findByText("Names could not be loaded. Showing user IDs where needed.");
  expect(screen.getAllByText("user-long-stable-id").length).toBeGreaterThan(0);
});
