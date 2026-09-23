// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@cogniplane/shared-types";
import { useSessionPages } from "./use-session-pages";

const api = vi.hoisted(() => ({ listSessions: vi.fn(), listArchivedSessions: vi.fn() }));
vi.mock("../lib/session-api", () => api);

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it.each([
  { status: "active" as const, personalOnly: false },
  { status: "archived" as const, personalOnly: false },
  { status: "active" as const, personalOnly: true }
])("debounces $status search, personal picker: $personalOnly, and clears immediately", async (options) => {
  const load = options.status === "archived" ? api.listArchivedSessions : api.listSessions;
  load.mockImplementation(async ({ search }: { search: string }) => ({
    sessions: [{ sessionId: search || "recent", sessionName: "Result" } as Session],
    trashRetentionDays: 30, nextCursor: "next"
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const { result, rerender } = renderHook(({ search }) => useSessionPages({ ...options, search }), { wrapper, initialProps: { search: "" } });
  await waitFor(() => expect(result.current.data?.sessions[0].sessionId).toBe("recent"));
  expect(load).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  let search = "";
  for (const character of "budget review") {
    search += character;
    rerender({ search });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(load).toHaveBeenCalledOnce();
    expect(result.current.data).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ search: "budget review", personalOnly: options.personalOnly }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.data?.sessions[0].sessionId).toBe("budget review");
  rerender({ search: "" });
  expect(result.current.data?.sessions[0].sessionId).toBe("recent");
  expect(result.current.isPending).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
  client.clear();
});
