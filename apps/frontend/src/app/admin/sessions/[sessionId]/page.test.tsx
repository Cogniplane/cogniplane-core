// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function filteredReturnHref() {
  const listQuery = new URLSearchParams({ status: "errored", userId: "a&b+#%" }).toString();
  navigation.search = new URL(sessionDetailHref("s1", listQuery), "http://localhost").search;
  return `/admin/sessions?${listQuery}`;
}

function expectReturnAction(href: string) {
  const back = screen.getByRole("link", { name: "Back to sessions" });
  expect(back.getAttribute("href")).toBe(href);
  expect(back.className).toContain("min-h-11");
  expect(back.className).toContain("w-full");
  expect(back.className).toContain("sm:w-auto");
  expect(back.className).toContain("focus-visible:ring-[3px]");
  return back;
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
  const expectedHref = filteredReturnHref();
  vi.mocked(getAdminSessionDetail).mockResolvedValue(detail);
  renderPage();

  await screen.findByRole("heading", { name: "Quarterly report" });
  const href = expectReturnAction(expectedHref).getAttribute("href")!;
  const back = new URL(href, "http://localhost");
  expect(back.pathname).toBe("/admin/sessions");
  expect(Object.fromEntries(back.searchParams)).toEqual({ status: "errored", userId: "a&b+#%" });
});

it("says when the session is missing or in another tenant", async () => {
  const expectedHref = filteredReturnHref();
  vi.mocked(getAdminSessionDetail).mockRejectedValue(
    new ApiError({ status: 404, code: "session_not_found", method: "GET", path: "/admin/sessions/s1", message: "session_not_found" })
  );
  renderPage();

  expect(await screen.findByText("Session not found or not in your tenant.")).toBeTruthy();
  expectReturnAction(expectedHref);
  expect(screen.queryByRole("button", { name: /Reload/ })).toBeNull();
  expect(getAdminSessionDetail).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Sidebar for s1")).toBeNull();
});

it("shows a load error", async () => {
  const expectedHref = filteredReturnHref();
  vi.mocked(getAdminSessionDetail).mockRejectedValue(new Error("Database is busy."));
  renderPage();

  expect(await screen.findByText("Database is busy.")).toBeTruthy();
  const back = expectReturnAction(expectedHref);
  expect(back.compareDocumentPosition(screen.getByRole("button", { name: "Reload session" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText("Sidebar for s1")).toBeNull();
});

it("keeps a filtered return action available while the session loads", async () => {
  const expectedHref = filteredReturnHref();
  let finish!: (value: AdminSessionDetailResponse) => void;
  vi.mocked(getAdminSessionDetail).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  renderPage();

  expect(screen.getByRole("status").textContent).toBe("Loading session…");
  const back = expectReturnAction(expectedHref);
  expect(screen.queryByRole("button", { name: /Reload/ })).toBeNull();
  back.focus();
  await act(async () => { finish(detail); });
  await screen.findByRole("heading", { name: "Quarterly report" });
  expect(document.activeElement).toBe(back);
});

it("places return navigation before reload and copy for a long session title", async () => {
  const longTitle = `Quarterly report ${"LongTitle".repeat(60)}`;
  vi.mocked(getAdminSessionDetail).mockResolvedValue({ overview: { ...overview, sessionName: longTitle } } as AdminSessionDetailResponse);
  renderPage();

  const title = await screen.findByRole("heading", { name: longTitle });
  const back = expectReturnAction("/admin/sessions");
  const reload = screen.getByRole("button", { name: "Reload session" });
  const copy = screen.getByRole("button", { name: "Copy session ID" });
  expect(Array.from(document.querySelectorAll("a, button"))).toEqual([back, reload, copy]);
  expect([back.tabIndex, reload.tabIndex, copy.tabIndex]).toEqual([0, 0, 0]);
  expect(back.parentElement?.className).toContain("flex-col");
  expect(back.parentElement?.className).toContain("sm:flex-row");
  expect(title.className).toContain("[overflow-wrap:anywhere]");
  expect(title.parentElement?.className).toContain("min-w-0");
});

it.each([false, true])("keeps retry focus ownership when focus leaves Reload: %s", async (moveFocus) => {
  const expectedHref = filteredReturnHref();
  vi.mocked(getAdminSessionDetail).mockRejectedValue(new Error("Database is busy."));
  renderPage();
  await screen.findByRole("alert");

  let finish!: (value: AdminSessionDetailResponse) => void;
  vi.mocked(getAdminSessionDetail).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const reload = screen.getByRole("button", { name: "Reload session" });
  reload.focus();
  fireEvent.click(reload);
  const pending = await screen.findByRole("button", { name: "Reloading…" });
  expect(document.activeElement).toBe(reload);
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(pending.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("alert").textContent).toBe("Database is busy.");
  const calls = vi.mocked(getAdminSessionDetail).mock.calls.length;
  fireEvent.click(pending);
  expect(getAdminSessionDetail).toHaveBeenCalledTimes(calls);
  const back = expectReturnAction(expectedHref);
  if (moveFocus) back.focus();

  await act(async () => { finish(detail); });
  await screen.findByRole("heading", { name: "Quarterly report" });
  await waitFor(() => expect(document.activeElement).toBe(moveFocus ? back : screen.getByRole("heading", { name: "Session detail" })));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps loaded evidence and the return action after a failed reload", async () => {
  const expectedHref = filteredReturnHref();
  vi.mocked(getAdminSessionDetail).mockResolvedValue(detail);
  renderPage();
  await screen.findByRole("heading", { name: "Quarterly report" });
  vi.mocked(getAdminSessionDetail).mockRejectedValue(new Error("Database is busy."));

  const reload = screen.getByRole("button", { name: "Reload session" });
  reload.focus();
  fireEvent.click(reload);
  expect((await screen.findByRole("alert")).textContent).toBe("Session detail could not be updated. The loaded evidence remains below. Database is busy.");
  await screen.findByRole("button", { name: "Reload session" });
  expect(screen.getByText("Sidebar for s1")).toBeTruthy();
  expectReturnAction(expectedHref);
  expect(document.activeElement).toBe(reload);
});
