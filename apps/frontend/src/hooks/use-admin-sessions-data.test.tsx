// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSessionRow, AdminSessionsListParams, AdminSessionsListResponse } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { listAdminSessions } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { useAdminSessionsData } from "./use-admin-sessions-data";

vi.mock("../lib/admin-api", () => ({ listAdminSessions: vi.fn() }));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function row(sessionId: string): AdminSessionRow {
  return {
    sessionId, userId: "u1", userEmail: null, createdAt: "2026-10-01T10:00:00.000Z",
    lastActivityAt: "2026-10-01T11:00:00.000Z", messageCount: 1, runtimeProvider: null, modelName: null,
    status: "active", alerts: [], skillsUsedCount: 0, mcpServersUsedCount: 0
  };
}

const page = (ids: string[], nextCursor: string | null): AdminSessionsListResponse => ({ items: ids.map(row), nextCursor });

function renderSessions(params?: AdminSessionsListParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useAdminSessionsData(params), { wrapper });
}

const ids = (sessions: AdminSessionRow[]) => sessions.map((session) => session.sessionId);

it("loads the first page with the filters and no cursor", async () => {
  vi.mocked(listAdminSessions).mockResolvedValue(page(["s1", "s2"], null));
  const { result } = renderSessions({ userId: "u1", status: "errored" });

  await waitFor(() => expect(ids(result.current.sessions)).toEqual(["s1", "s2"]));
  expect(listAdminSessions).toHaveBeenCalledWith({ userId: "u1", status: "errored", cursor: undefined });
  expect(result.current).toMatchObject({ available: true, error: null, isLoading: false, hasMore: false });
});

it("loads the next page from the cursor and appends it", async () => {
  let finish!: () => void;
  vi.mocked(listAdminSessions)
    .mockResolvedValueOnce(page(["s1", "s2"], "cursor-2"))
    .mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve(page(["s3"], null)); }));
  const { result } = renderSessions({ userId: "u1" });
  await waitFor(() => expect(result.current.hasMore).toBe(true));

  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.isLoadingMore).toBe(true));
  // A second request while one is loading is ignored.
  act(() => result.current.loadMore());
  expect(listAdminSessions).toHaveBeenCalledTimes(2);
  expect(listAdminSessions).toHaveBeenLastCalledWith({ userId: "u1", cursor: "cursor-2" });

  await act(async () => { finish(); });
  await waitFor(() => expect(ids(result.current.sessions)).toEqual(["s1", "s2", "s3"]));
  expect(result.current).toMatchObject({ hasMore: false, isLoadingMore: false });
});

it("does not request more when there is no next page", async () => {
  vi.mocked(listAdminSessions).mockResolvedValue(page(["s1"], null));
  const { result } = renderSessions();
  await waitFor(() => expect(ids(result.current.sessions)).toEqual(["s1"]));

  act(() => result.current.loadMore());

  expect(listAdminSessions).toHaveBeenCalledTimes(1);
});

it("hides the list and names the feature when the deployment has no session route", async () => {
  vi.mocked(listAdminSessions).mockRejectedValue(
    new ApiError({ status: 404, code: "not_found", method: "GET", path: "/admin/sessions", message: "not_found" })
  );
  const { result } = renderSessions();

  await waitFor(() => expect(result.current.available).toBe(false));
  expect(result.current).toMatchObject({ sessions: [], error: "Session review is not available on this deployment yet." });
});

it("shows a load error but keeps the feature available", async () => {
  vi.mocked(listAdminSessions).mockRejectedValue("offline");
  const { result } = renderSessions();

  await waitFor(() => expect(result.current.error).toBe("Failed to load sessions."));
  expect(result.current.available).toBe(true);
});
