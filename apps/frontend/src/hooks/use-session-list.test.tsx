// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@cogniplane/shared-types";

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  archiveSession: vi.fn(),
  createSession: vi.fn(),
  createProjectSession: vi.fn(),
  renameSession: vi.fn()
}));

vi.mock("../lib/session-api", () => ({
  listSessions: api.listSessions,
  deleteSession: api.deleteSession,
  archiveSession: api.archiveSession,
  createSession: api.createSession,
  renameSession: api.renameSession
}));

vi.mock("../lib/project-api", () => ({
  createProjectSession: api.createProjectSession
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ user: { userId: "u-1", tenantId: "t-1" } })
}));

import { queryKeys } from "../lib/query-keys";
import { useSessionList } from "./use-session-list";

function makeSession(sessionId: string): Session {
  return {
    sessionId,
    sessionName: sessionId,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z"
  } as Session;
}

function renderSessionList(syncUrl = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(({ enabled }) => useSessionList({ enabled, syncUrl }), { wrapper, initialProps: { enabled: true } });
}

// The hook invalidates the list after a delete, so the fake backend has to
// actually drop the row — otherwise the refetch puts it straight back.
let serverSessions: Session[] = [];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  serverSessions = [makeSession("s-1"), makeSession("s-2")];
  api.listSessions.mockImplementation(async () => [...serverSessions]);
  api.deleteSession.mockImplementation(async (sessionId: string) => {
    serverSessions = serverSessions.filter((s) => s.sessionId !== sessionId);
  });
  api.createSession.mockImplementation(async (name: string) => {
    const created = { ...makeSession("new-session"), sessionName: name };
    serverSessions = [created, ...serverSessions];
    return created;
  });
  api.createProjectSession.mockImplementation(async (projectId: string, name: string) => {
    const created = { ...makeSession("project-session"), projectId, sessionName: name };
    serverSessions = [created, ...serverSessions];
    return created;
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

it("creates a project session through the project endpoint", async () => {
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.sessions).toHaveLength(2));

  await act(async () => { await result.current.createSession("project-1"); });

  expect(api.createProjectSession).toHaveBeenCalledWith("project-1", "Session 3");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(result.current.selectedSession?.projectId).toBe("project-1");
  expect(result.current.selectedSession?.sessionName).toBe("Session 3");
});

it("reloads session lists without refetching an active detail query", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const loadDetail = vi.fn(async () => ({ messages: [] }));
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => {
    useQuery({ queryKey: queryKeys.sessions.detail("s-1"), queryFn: loadDetail });
    return useSessionList();
  }, { wrapper });
  await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  expect(loadDetail).toHaveBeenCalledOnce();
  const listCalls = api.listSessions.mock.calls.length;
  await act(async () => { await result.current.reload(); });
  expect(api.listSessions.mock.calls.length).toBe(listCalls + 1);
  expect(loadDetail).toHaveBeenCalledOnce();
});


describe("archiving sessions", () => {
  it.each([false, true])("removes the session and updates persisted selection, last session: %s", async (last) => {
    if (last) serverSessions = [makeSession("s-1")];
    api.archiveSession.mockImplementation(async (id: string) => {
      serverSessions = serverSessions.filter((session) => session.sessionId !== id);
      return { ...makeSession(id), status: "archived" };
    });
    const { result } = renderSessionList();
    await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
    const historyLength = window.history.length;
    act(() => result.current.archiveSession("s-1"));
    await waitFor(() => expect(result.current.sessions).toHaveLength(last ? 0 : 1));
    expect(window.history.length).toBe(historyLength);
    expect(window.location.search).toBe(last ? "" : "?session=s-2");
    expect(result.current.selectedSessionId).toBe(last ? null : "s-2");
    expect(window.localStorage.getItem("cogniplane:selected-session-id:v1")).toBe(last ? null : "s-2");
  });

  it("keeps the session and selection on archive failure", async () => {
    api.archiveSession.mockRejectedValueOnce(new Error("Session has a pending approval"));
    const { result } = renderSessionList();
    await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
    act(() => result.current.archiveSession("s-1"));
    await waitFor(() => expect(result.current.error).toBe("Session has a pending approval"));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.selectedSessionId).toBe("s-1");
  });
});

it("opens a linked session before the stored selection and updates the link when switching", async () => {
  window.localStorage.setItem("cogniplane:selected-session-id:v1", "s-1");
  window.history.replaceState(null, "", "/?session=s-2");
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-2"));
  act(() => result.current.selectSession("s-1"));
  expect(new URLSearchParams(window.location.search).get("session")).toBe("s-1");
});

it("does not select an inaccessible session from a link", async () => {
  window.history.replaceState(null, "", "/?session=someone-elses-session");
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
});

it("navigates between sessions with Back and Forward", async () => {
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  const initialLength = window.history.length;
  act(() => result.current.selectSession("s-2"));
  expect(window.history.length).toBe(initialLength + 1);
  act(() => window.history.back());
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  act(() => window.history.forward());
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-2"));
});

it.each([false, true])("does not read or change session URLs on other routes, syncUrl: %s", async (syncUrl) => {
  window.history.replaceState(null, "", "/artifacts?session=s-2&filter=pdf");
  const { result } = renderSessionList(syncUrl);
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  act(() => result.current.selectSession("s-2"));
  expect(window.location.pathname + window.location.search).toBe("/artifacts?session=s-2&filter=pdf");
});

it("leaves the root URL alone unless URL sync is enabled", async () => {
  window.history.replaceState(null, "", "/?session=s-2");
  const { result } = renderSessionList(false);
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  expect(window.location.search).toBe("?session=s-2");
});

it("clears the session URL on sign-out and preserves an initial link during auth loading", async () => {
  window.history.replaceState(null, "", "/?session=s-2");
  const { result, rerender } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-2"));
  rerender({ enabled: false });
  await waitFor(() => expect(result.current.selectedSessionId).toBeNull());
  expect(window.location.search).toBe("");
  window.history.replaceState(null, "", "/?session=s-1");
  rerender({ enabled: false });
  expect(window.location.search).toBe("?session=s-1");
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
});

it("replaces a deleted session URL without adding history and rejects stale history entries", async () => {
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  act(() => result.current.selectSession("s-2"));
  const length = window.history.length;
  act(() => result.current.deleteSession("s-2"));
  await act(async () => { await result.current.confirmDelete(); });
  await waitFor(() => expect(result.current.selectedSessionId).toBe("s-1"));
  expect(window.location.search).toBe("?session=s-1");
  expect(window.history.length).toBe(length);
  act(() => {
    window.history.replaceState(null, "", "/?session=s-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(result.current.selectedSessionId).toBe("s-1");
  expect(window.location.search).toBe("?session=s-1");
});
