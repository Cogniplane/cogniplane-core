// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminSessionDetailOverview, AdminSessionDetailResponse } from "@cogniplane/shared-types";

import { getAdminSessionDetail } from "../../../../lib/admin-api";
import { sessionDetailHref } from "../../../../lib/admin-session-links";
import { ApiError } from "../../../../lib/api-client";
import AdminSessionDetailPage from "./page";

const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ sessionId: "s1" }),
  useSearchParams: () => new URLSearchParams(navigation.search)
}));
vi.mock("../../../../lib/admin-api", () => ({ getAdminSessionDetail: vi.fn() }));
// The sidebar has its own tests; here it only proves that the page passed the detail on.
vi.mock("../../../../components/admin/sessions/admin-session-detail-sidebar", () => ({
  AdminSessionDetailSidebar: (props: { detail: AdminSessionDetailResponse }) => <p>Sidebar for {props.detail.overview.sessionId}</p>
}));

const overview: AdminSessionDetailOverview = {
  sessionId: "s1", userId: "u1", userEmail: "ana@example.com", tenantId: "t1", sessionName: "Quarterly report",
  status: "active", runtimeProvider: "deep-agents", createdAt: "2026-10-01T10:00:00.000Z",
  lastActivityAt: "2026-10-01T11:00:00.000Z", messageCount: 4, totalCostUsd: 0.1, totalTokens: 1200
};
// Only the overview is read outside the mocked sidebar.
const detail = { overview } as AdminSessionDetailResponse;

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => { navigation.search = ""; });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(<QueryClientProvider client={client}><AdminSessionDetailPage /></QueryClientProvider>);
}

it("shows the session header and hands the detail to the sidebar", async () => {
  vi.mocked(getAdminSessionDetail).mockResolvedValue(detail);
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderPage();

  expect(screen.getByText("Loading session…")).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "Quarterly report" })).toBeTruthy();
  expect(screen.getByText(/^ana@example.com · started/)).toBeTruthy();
  expect(screen.getByText("Sidebar for s1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
  expect(writeText).toHaveBeenCalledWith("s1");
});

it("returns to the filtered session list it came from, special characters included", async () => {
  // Arrive the way the list page links here.
  const listQuery = new URLSearchParams({ status: "errored", userId: "a&b" }).toString();
  navigation.search = new URL(sessionDetailHref("s1", listQuery), "http://localhost").search;
  vi.mocked(getAdminSessionDetail).mockResolvedValue(detail);
  renderPage();

  const href = (await screen.findByRole("link", { name: "← Back to sessions" })).getAttribute("href")!;
  const back = new URL(href, "http://localhost");
  expect(back.pathname).toBe("/admin/sessions");
  expect(Object.fromEntries(back.searchParams)).toEqual({ status: "errored", userId: "a&b" });
});

it("says when the session is missing or in another tenant", async () => {
  vi.mocked(getAdminSessionDetail).mockRejectedValue(
    new ApiError({ status: 404, code: "session_not_found", method: "GET", path: "/admin/sessions/s1", message: "session_not_found" })
  );
  renderPage();

  expect(await screen.findByText("Session not found or not in your tenant.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to sessions" }).getAttribute("href")).toBe("/admin/sessions");
  expect(screen.queryByText("Sidebar for s1")).toBeNull();
});

it("shows a load error", async () => {
  vi.mocked(getAdminSessionDetail).mockRejectedValue(new Error("Database is busy."));
  renderPage();

  expect(await screen.findByText("Database is busy.")).toBeTruthy();
  expect(screen.queryByText("Sidebar for s1")).toBeNull();
});
