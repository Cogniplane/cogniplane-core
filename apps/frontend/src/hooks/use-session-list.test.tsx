// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@cogniplane/shared-types";

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn()
}));

vi.mock("../lib/session-api", () => ({
  listSessions: api.listSessions,
  deleteSession: api.deleteSession,
  createSession: api.createSession,
  renameSession: api.renameSession
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ user: { userId: "u-1", tenantId: "t-1" } })
}));

import { useSessionList } from "./use-session-list";

function makeSession(sessionId: string): Session {
  return {
    sessionId,
    sessionName: sessionId,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z"
  } as Session;
}

function renderSessionList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useSessionList(), { wrapper });
}

// The hook invalidates the list after a delete, so the fake backend has to
// actually drop the row — otherwise the refetch puts it straight back.
let serverSessions: Session[] = [];

beforeEach(() => {
  window.localStorage.clear();
  serverSessions = [makeSession("s-1"), makeSession("s-2")];
  api.listSessions.mockImplementation(async () => [...serverSessions]);
  api.deleteSession.mockImplementation(async (sessionId: string) => {
    serverSessions = serverSessions.filter((s) => s.sessionId !== sessionId);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionList: deleting the selected session", () => {
  it("falls back to the first remaining session and persists the choice", async () => {
    const { result } = renderSessionList();
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.selectSession("s-1"));
    expect(result.current.selectedSessionId).toBe("s-1");

    act(() => result.current.deleteSession("s-1"));
    await act(async () => {
      await result.current.confirmDelete();
    });

    await waitFor(() => expect(result.current.selectedSessionId).toBe("s-2"));
    // Persisted too, so a reload doesn't reopen the session that's gone.
    expect(window.localStorage.getItem("cogniplane:selected-session-id:v1")).toBe("s-2");
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["s-2"]);
  });

  it("clears the selection when the deleted session was the last one", async () => {
    serverSessions = [makeSession("s-1")];
    const { result } = renderSessionList();
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.selectSession("s-1"));
    act(() => result.current.deleteSession("s-1"));
    await act(async () => {
      await result.current.confirmDelete();
    });

    await waitFor(() => expect(result.current.selectedSessionId).toBeNull());
    expect(window.localStorage.getItem("cogniplane:selected-session-id:v1")).toBeNull();
  });

  it("leaves the selection alone when a different session is deleted", async () => {
    const { result } = renderSessionList();
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.selectSession("s-2"));
    act(() => result.current.deleteSession("s-1"));
    await act(async () => {
      await result.current.confirmDelete();
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.selectedSessionId).toBe("s-2");
  });
});
