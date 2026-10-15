// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { deleteMemory, listMemories } from "@/lib/memories-api";
import SettingsMemoriesPage from "./page";

const auth = vi.hoisted(() => ({ user: null as null | { tenantId: string; userId: string } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("@/lib/memories-api", () => ({ listMemories: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const memory = {
  id: "m1", name: "units", content: "Metric.", metadata: {}, version: 1, provenance: "agent_approved" as const,
  approvedAt: "2026-07-02T10:00:00.000Z", createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-02T10:00:00.000Z"
};

let client: QueryClient;
const page = () => <QueryClientProvider client={client}><SettingsMemoriesPage /></QueryClientProvider>;

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  auth.user = { tenantId: "tenant-a", userId: "member-1" };
  vi.mocked(listMemories).mockImplementation(async () => ({
    scope: { tenantId: auth.user!.tenantId, userId: auth.user!.userId }, memories: [memory], total: 1
  }));
  vi.mocked(deleteMemory).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); client.clear(); });

it("shows nothing and loads nothing while nobody is signed in", () => {
  auth.user = null;
  const { container } = render(page());

  expect(container.textContent).toBe("");
  expect(listMemories).not.toHaveBeenCalled();
});

it("writes with the signed-in account's scope", async () => {
  render(page());
  await screen.findByText("Metric.");

  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  fireEvent.click((await screen.findAllByRole("button", { name: "Delete memory" })).at(-1)!);

  await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith("m1", { tenantId: "tenant-a", userId: "member-1" }));
});

it("starts over for another account instead of showing the first account's memories", async () => {
  const view = render(page());
  await screen.findByText("Metric.");

  auth.user = { tenantId: "tenant-b", userId: "member-1" };
  vi.mocked(listMemories).mockImplementation(async () => ({
    scope: { tenantId: "tenant-b", userId: "member-1" }, memories: [{ ...memory, id: "m9", name: "other-org", content: "Another organization." }], total: 1
  }));
  view.rerender(page());

  expect(await screen.findByText("Another organization.")).toBeTruthy();
  expect(screen.queryByText("Metric.")).toBeNull();
});
