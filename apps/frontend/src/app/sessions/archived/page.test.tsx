// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Session } from "@cogniplane/shared-types";
import ArchivedSessionsPage from "./page";

const api = vi.hoisted(() => ({ listArchivedSessions: vi.fn(), restoreSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock("@/lib/session-api", () => api);
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { userId: "u" } }) }));
vi.mock("@/lib/auth-guard", () => ({ AuthGuard: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/console-page-header", () => ({ ConsolePageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

let rows: Session[];
beforeEach(() => {
  vi.resetAllMocks();
  rows = [{ sessionId: "s1", userId: "u", sessionName: "Research notes", status: "archived", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z", archivedAt: "2026-09-13T00:00:00Z" }];
  api.listArchivedSessions.mockImplementation(async () => [...rows]);
  api.restoreSession.mockImplementation(async () => { rows = []; });
  api.deleteSession.mockImplementation(async () => { rows = []; });
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ArchivedSessionsPage /></QueryClientProvider>);
}

it("searches and restores an archived session", async () => {
  mount();
  await screen.findByText("Research notes");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "missing" } });
  expect(screen.getByText("No matching sessions")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByText("No archived sessions");
  expect(api.restoreSession).toHaveBeenCalledWith("s1");
  expect(api.deleteSession).not.toHaveBeenCalled();
});

it("requires confirmation to move a session to Trash and keeps the dialog open for retry on failure", async () => {
  mount();
  await screen.findByText("Research notes");
  fireEvent.click(screen.getByRole("button", { name: "Move Research notes to Trash" }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Move Research notes to Trash" }));
  api.deleteSession.mockRejectedValueOnce(new Error("Network error"));
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  await screen.findByText("Move to Trash failed. Try again.");
  expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move to Trash" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  await screen.findByText("No archived sessions");
  expect(api.deleteSession).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("retains the row after restore failure and retries failed list loads", async () => {
  api.listArchivedSessions.mockRejectedValueOnce(new Error("Offline"));
  mount();
  await screen.findByText("Could not load archived sessions.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Research notes");
  api.restoreSession.mockRejectedValueOnce(new Error("Restore failed"));
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByText("Restore failed");
  expect(screen.getByText("Research notes")).toBeTruthy();
});
