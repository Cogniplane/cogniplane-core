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
  api.listSessions.mockImplementation(async ({ ids }: { ids?: string[] } = {}) => ({ sessions: serverSessions.filter((row) => !ids || ids.includes(row.sessionId)), trashRetentionDays: 7 }));
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

it("preserves session references on identical refetches and retention during a mutation", async () => {
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  const sessions = result.current.sessions;
  await act(async () => { await result.current.reload(); });
  expect(result.current.sessions).toBe(sessions);
  api.listSessions.mockImplementation(() => new Promise(() => {}));
  await act(async () => { await result.current.createSession(); });
  await waitFor(() => expect(result.current.sessions).toHaveLength(3));
  expect(result.current.trashRetentionDays).toBe(7);
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
    expect(result.current.listError).toBeNull();
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
  await waitFor(() => expect(window.location.search).toBe("?session=s-1"));
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
  await waitFor(() => expect(window.location.search).toBe("?session=s-1"));
  expect(window.history.length).toBe(length);
  act(() => {
    window.history.replaceState(null, "", "/?session=s-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(result.current.selectedSessionId).toBe("s-1");
  await waitFor(() => expect(window.location.search).toBe("?session=s-1"));
});

it("loads older pages, retains rows on failure, retries and deduplicates sessions moved between pages", async () => {
  let fail = true;
  api.listSessions.mockImplementation(async ({ cursor }: { cursor?: string } = {}) => {
    if (cursor === "older" && fail) throw new Error("Page unavailable");
    return { sessions: cursor ? [makeSession("s-2"), makeSession("s-3")] : [makeSession("s-1"), makeSession("s-2")],
      nextCursor: cursor ? null : "older", trashRetentionDays: 7 };
  });
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.hasMore).toBe(true));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error).toBe("Page unavailable"));
  expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["s-1", "s-2"]);
  fail = false;
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["s-1", "s-2", "s-3"]));
  expect(result.current.hasMore).toBe(false);
  expect(result.current.selectedSessionId).toBe("s-1");
  act(() => result.current.selectSession("s-3"));
  await act(async () => { await result.current.reload(); });
  expect(result.current.selectedSession?.sessionId).toBe("s-3");
});

it.each(["url", "storage"])("restores an older %s selection and pins outside the first page, preserving them through search", async (source) => {
  if (source === "url") window.history.replaceState(null, "", "/?session=old");
  else window.localStorage.setItem("cogniplane:selected-session-id:v1", "old");
  window.localStorage.setItem("cogniplane:pinned-sessions:v1:u-1", JSON.stringify(["pinned"]));
  api.listSessions.mockImplementation(async ({ ids, search }: { ids?: string[]; search?: string } = {}) => ({
    sessions: ids ? ids.filter((id) => ["old", "pinned", "found-old"].includes(id)).map(makeSession) : search ? [makeSession("found-old")] : [makeSession("recent")],
    nextCursor: null, trashRetentionDays: 7
  }));
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSession?.sessionId).toBe("old"));
  expect(result.current.sessions.some((s) => s.sessionId === "pinned")).toBe(true);
  act(() => result.current.setSearch("found"));
  await waitFor(() => expect(result.current.sidebarSessions.map((s) => s.sessionId)).toEqual(["found-old"]));
  expect(result.current.selectedSession?.sessionId).toBe("old");
  act(() => result.current.selectSession("found-old"));
  // Once selected, the session is resolved independently when search is cleared.
  api.listSessions.mockImplementation(async ({ ids }: { ids?: string[] } = {}) => ({
    sessions: ids ? ids.map(makeSession) : [makeSession("recent")], nextCursor: null, trashRetentionDays: 7
  }));
  act(() => result.current.setSearch(""));
  await waitFor(() => expect(result.current.selectedSession?.sessionId).toBe("found-old"));
  expect(window.location.search).toBe("?session=found-old");
});

it("keeps a saved URL on lookup failure and restores it after retry", async () => {
  window.history.replaceState(null, "", "/?session=old");
  let fail = true;
  api.listSessions.mockImplementation(async ({ ids }: { ids?: string[] } = {}) => {
    if (ids && fail) throw new Error("Offline");
    return { sessions: [makeSession(ids ? "old" : "recent")], nextCursor: null, trashRetentionDays: 7 };
  });
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.error).toContain("saved sessions"));
  expect(window.location.search).toBe("?session=old");
  expect(result.current.selectedSessionId).toBeNull();
  fail = false;
  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(result.current.selectedSession?.sessionId).toBe("old"));
});

it("resolves an older history link and falls back when the server no longer grants access", async () => {
  api.listSessions.mockImplementation(async ({ ids }: { ids?: string[] } = {}) => ({
    sessions: ids ? ids.includes("old") ? [makeSession("old")] : [] : [makeSession("recent")], nextCursor: null, trashRetentionDays: 7
  }));
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("recent"));
  act(() => {
    window.history.pushState(null, "", "/?session=old");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(result.current.selectedSession?.sessionId).toBe("old"));
  act(() => {
    window.history.pushState(null, "", "/?session=denied");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(window.location.search).toBe("?session=old"));
  expect(result.current.selectedSessionId).toBe("old");
});

it("resolves more than one page of saved pins through bounded requests", async () => {
  const pins = Array.from({ length: 105 }, (_, index) => `pin-${index}`);
  window.localStorage.setItem("cogniplane:pinned-sessions:v1:u-1", JSON.stringify(pins));
  api.listSessions.mockImplementation(async ({ ids }: { ids?: string[] } = {}) => ({
    sessions: (ids ?? ["recent"]).map(makeSession), nextCursor: null, trashRetentionDays: 7
  }));
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.sessions).toHaveLength(106));
  const batches = api.listSessions.mock.calls.map(([options]) => options?.ids).filter(Boolean) as string[][];
  expect(batches.map((ids) => ids.length)).toEqual([100, 5]);
  expect(new Set(batches.flat())).toEqual(new Set(pins));
});

it("ignores a late search response after switching terms", async () => {
  let release!: (page: { sessions: Session[]; trashRetentionDays: number }) => void;
  api.listSessions.mockImplementation(async ({ search }: { search?: string } = {}) => {
    if (search === "first") return new Promise((resolve) => { release = resolve; });
    return { sessions: [makeSession(search || "recent")], nextCursor: null, trashRetentionDays: 7 };
  });
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("recent"));
  act(() => result.current.setSearch("first"));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  act(() => result.current.setSearch("second"));
  await waitFor(() => expect(result.current.sidebarSessions[0]?.sessionId).toBe("second"));
  await act(async () => { release({ sessions: [makeSession("first")], trashRetentionDays: 7 }); });
  expect(result.current.sidebarSessions[0]?.sessionId).toBe("second");
  expect(result.current.selectedSessionId).toBe("recent");
});

it.each(["delete", "archive"])("excludes search-only hits after clearing and from %s selection fallbacks", async (action) => {
  let removed = false;
  api.listSessions.mockImplementation(async ({ search }: { search?: string } = {}) => ({
    sessions: search ? [makeSession("search-only")] : removed ? [] : [makeSession("recent")],
    nextCursor: null, trashRetentionDays: 7
  }));
  api.deleteSession.mockImplementation(async () => { removed = true; });
  api.archiveSession.mockImplementation(async () => { removed = true; return { ...makeSession("recent"), status: "archived" }; });
  const { result } = renderSessionList();
  await waitFor(() => expect(result.current.selectedSessionId).toBe("recent"));
  act(() => result.current.setSearch("term"));
  await waitFor(() => expect(result.current.sidebarSessions[0]?.sessionId).toBe("search-only"));
  act(() => result.current.setSearch(""));
  expect(result.current.sessions.map((row) => row.sessionId)).toEqual(["recent"]);
  act(() => result.current.setSearch("term"));
  await waitFor(() => expect(result.current.sidebarSessions[0]?.sessionId).toBe("search-only"));
  if (action === "delete") {
    act(() => result.current.deleteSession("recent"));
    await act(async () => { await result.current.confirmDelete(); });
  } else {
    act(() => result.current.archiveSession("recent"));
  }
  await waitFor(() => expect(result.current.selectedSessionId).toBeNull());
  expect(window.location.search).toBe("");
});

it.each([false, true])("restores only base or saved sessions when search finishes before the initial list, base exists: %s", async (hasBase) => {
  window.history.replaceState(null, "", "/?session=missing");
  window.localStorage.setItem("cogniplane:selected-session-id:v1", "also-missing");
  let resolveBase!: (page: { sessions: Session[]; trashRetentionDays: number }) => void;
  api.listSessions.mockImplementation(async ({ search, ids }: { search?: string; ids?: string[] } = {}) => {
    if (ids) return { sessions: [], trashRetentionDays: 7 };
    if (search) return { sessions: [makeSession("search-only")], trashRetentionDays: 7 };
    return new Promise((resolve) => { resolveBase = resolve; });
  });
  const { result } = renderSessionList();
  await waitFor(() => expect(resolveBase).toBeTypeOf("function"));
  act(() => result.current.setSearch("term"));
  await waitFor(() => expect(result.current.sidebarSessions[0]?.sessionId).toBe("search-only"));
  expect(result.current.selectedSessionId).toBeNull();
  await act(async () => { resolveBase({ sessions: hasBase ? [makeSession("recent")] : [], trashRetentionDays: 7 }); });
  await waitFor(() => expect(window.location.search).toBe(hasBase ? "?session=recent" : ""));
  expect(result.current.selectedSessionId).toBe(hasBase ? "recent" : null);
  expect(window.localStorage.getItem("cogniplane:selected-session-id:v1")).toBe(hasBase ? "recent" : null);
  expect(result.current.sidebarSessions[0]?.sessionId).toBe("search-only");
});
