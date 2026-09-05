// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

import type { Approval, Artifact, Message } from "@cogniplane/shared-types";

import { queryKeys } from "../lib/query-keys";
import { useSessionData } from "./use-session-data";

// One settler per pending listMessages call, so resolve and reject can never
// drift out of step the way two parallel arrays would.
type MessageSettler = {
  resolve: (messages: unknown[], hasMore?: boolean) => void;
  reject: (error: Error) => void;
};
const apiState = vi.hoisted(() => ({
  pendingMessageLoads: [] as MessageSettler[],
  artifactResponses: [] as Array<Promise<unknown[]>>,
  approvals: [] as unknown[]
}));

vi.mock("../lib/message-api", () => ({
  listMessages: vi.fn(
    () =>
      new Promise<{ messages: unknown[]; hasMore: boolean }>((resolve, reject) => {
        // listMessages returns a paged envelope now. Tests still settle with a
        // bare Message[], so wrap it here rather than churning every call site;
        // hasMore defaults false and is overridden where it's the subject.
        apiState.pendingMessageLoads.push({
          resolve: (messages: unknown[], hasMore = false) => resolve({ messages, hasMore }),
          reject
        });
      })
  )
}));

vi.mock("../lib/artifact-api", () => ({
  listArtifacts: vi.fn(() => apiState.artifactResponses.shift() ?? Promise.resolve([]))
}));

vi.mock("../lib/session-api", () => ({
  listApprovals: vi.fn(async () => apiState.approvals)
}));

function serverMessage(messageId: string, content: string): Message {
  return {
    messageId,
    sessionId: "s-1",
    role: "user",
    status: "completed",
    content,
    reasoningContent: "",
    reasoningSegments: null,
    planContent: "",
    toolResults: [],
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    piiScanRunId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function artifact(artifactId: string, status: Artifact["status"]): Artifact {
  return { artifactId, artifactName: artifactId, status } as Artifact;
}

function approval(approvalId: string, sessionId: string): Approval {
  return {
    approvalId,
    sessionId,
    itemId: "item-1",
    kind: "mcp_tool",
    title: "Approve",
    summary: "Pending action",
    status: "pending"
  };
}

function deferredArtifacts() {
  let resolve!: (artifacts: Artifact[]) => void;
  const promise = new Promise<Artifact[]>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function renderSessionData(initialSessionId: string | null = "s-1") {
  // Mirror the app's 30s staleTime: a switch-back inside that window is exactly
  // the case where the cache would otherwise be served with no refetch.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } }
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const onError = vi.fn();

  const rendered = renderHook(
    ({ sessionId }: { sessionId: string | null }) =>
      useSessionData({
        selectedSessionId: sessionId,
        onError
      }),
    { wrapper, initialProps: { sessionId: initialSessionId } }
  );
  return { ...rendered, onError, queryClient };
}

async function settleInitialLoad(
  result: { current: ReturnType<typeof useSessionData> },
  resultMessages: Message[]
) {
  // The mounted useQuery issues the first listMessages call; settle it AND
  // wait for the populate effect to apply it (TanStack batches the query
  // notification, so the effect can land a tick after the resolve).
  await act(async () => {
    apiState.pendingMessageLoads.shift()?.resolve(resultMessages);
  });
  await waitFor(() => {
    expect(result.current.isSessionDataReady).toBe(true);
    expect(result.current.messages).toHaveLength(resultMessages.length);
  });
}

describe("useSessionData: refreshSessionData vs in-flight sends", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
    apiState.artifactResponses.length = 0;
    apiState.approvals = [];
  });

  it("a refresh that completes uninterrupted replaces messages with the server snapshot", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, [serverMessage("m-1", "turn 1 question")]);

    let refreshDone: Promise<void> | null = null;
    act(() => {
      refreshDone = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([
        serverMessage("m-1", "turn 1 question"),
        serverMessage("m-2", "turn 1 answer")
      ]);
      await refreshDone;
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "turn 1 question",
        "turn 1 answer"
      ])
    );
  });

  it("overlapping refreshes resolve last-call-wins, not last-land-wins", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    let firstRefresh: Promise<void> | null = null;
    let secondRefresh: Promise<void> | null = null;
    act(() => {
      firstRefresh = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    act(() => {
      secondRefresh = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(2));

    const [resolveFirst, resolveSecond] = apiState.pendingMessageLoads.splice(0, 2);

    // The newer refresh lands first with newer data...
    await act(async () => {
      resolveSecond?.resolve([serverMessage("m-new", "newer snapshot")]);
      await secondRefresh;
    });
    // ...then the older one lands with stale data and must be discarded.
    await act(async () => {
      resolveFirst?.resolve([serverMessage("m-old", "stale snapshot")]);
      await firstRefresh;
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.content)).toEqual(["newer snapshot"])
    );
  });
});

describe("useSessionData: truncated transcripts", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
  });

  it("exposes hasMoreMessages so a clipped transcript can be surfaced", async () => {
    const { result } = renderSessionData();

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-1", "newest kept turn")], true);
    });
    await waitFor(() => {
      expect(result.current.isSessionDataReady).toBe(true);
    });

    // Without this the backend's newest-N cap drops older turns with nothing in
    // the UI to say so, which is indistinguishable from a short conversation.
    expect(result.current.hasMoreMessages).toBe(true);
  });

  it("clears hasMoreMessages when a later refresh returns a complete transcript", async () => {
    const { result } = renderSessionData();

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-1", "kept")], true);
    });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    let refreshDone: Promise<void> | null = null;
    act(() => {
      refreshDone = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-1", "kept")], false);
      await refreshDone;
    });

    await waitFor(() => expect(result.current.hasMoreMessages).toBe(false));
  });
});

describe("useSessionData: switch-back serves fresh data, not the cached snapshot (R72)", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
  });

  it("holds readiness until a fetch that started after the switch resolves", async () => {
    const { result, rerender } = renderSessionData("s-1");
    await settleInitialLoad(result, [serverMessage("m-1", "A turn 1")]);

    // Switch to B and settle it, so A's entry stays in the cache.
    rerender({ sessionId: "s-2" });
    expect(result.current.messages).toEqual([]);
    expect(result.current.isSessionDataReady).toBe(false);
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-9", "B turn 1")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    // Back to A, well inside the 30s stale window. The cached A entry is
    // returned synchronously, but it predates whatever the agent wrote while
    // the user was away.
    rerender({ sessionId: "s-1" });

    // The consumer reads `initialMessages` once, at construction, so readiness
    // must stay false while only the stale snapshot is available. Asserting the
    // query was invalidated would pass here with the bug still on screen.
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    expect(result.current.isSessionDataReady).toBe(false);

    // The post-switch fetch lands with the turn that arrived while away.
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([
        serverMessage("m-1", "A turn 1"),
        serverMessage("m-2", "A turn 2, written while away")
      ]);
    });

    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "A turn 1",
      "A turn 2, written while away"
    ]);
  });

  it("stays ready after a post-turn refresh writes through the cache", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, [serverMessage("m-1", "turn 1")]);

    let refreshDone: Promise<void> | null = null;
    act(() => {
      refreshDone = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    expect(result.current.isSessionDataReady).toBe(true);
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([
        serverMessage("m-1", "turn 1"),
        serverMessage("m-2", "turn 2")
      ]);
      await refreshDone;
    });

    // The refresh writes the cache itself, so its data is newer than the switch.
    expect(result.current.isSessionDataReady).toBe(true);
  });
});

describe("useSessionData: a failed post-switch refetch falls back to the cache", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
  });

  it("renders the cached transcript rather than holding readiness false forever", async () => {
    const { result, rerender } = renderSessionData("s-1");
    await settleInitialLoad(result, [serverMessage("m-1", "A turn 1")]);

    rerender({ sessionId: "s-2" });
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-9", "B turn 1")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    // Back to A; the freshness refetch fails (network blip, 5xx, restart).
    rerender({ sessionId: "s-1" });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.reject(new Error("network down"));
    });

    // `dataUpdatedAt` never advances on a failure, so a gate keyed only on it
    // would leave the shell rendering an empty pane over good cached rows.
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));
    expect(result.current.messages.map((m) => m.content)).toEqual(["A turn 1"]);
  });

  it("does not reuse a previous refetch error as freshness on a later revisit", async () => {
    const { result, rerender } = renderSessionData("s-1");
    await settleInitialLoad(result, [serverMessage("m-1", "A cached")]);

    rerender({ sessionId: "s-2" });
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-2", "B cached")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    rerender({ sessionId: "s-1" });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.reject(new Error("first revisit failed"));
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    rerender({ sessionId: "s-2" });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("m-2", "B refreshed")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    rerender({ sessionId: "s-1" });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));

    expect(result.current.messages.map((message) => message.content)).toEqual(["A cached"]);
    expect(result.current.isSessionDataReady).toBe(false);

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.reject(new Error("second revisit failed"));
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));
  });
});

describe("useSessionData: session-scoped ownership", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
    apiState.artifactResponses.length = 0;
    apiState.approvals = [];
  });

  it("clears rows, readiness, and approvals when the selection becomes null", async () => {
    const pendingApproval = approval("a-1", "s-1");
    apiState.approvals = [pendingApproval];
    const { result, rerender } = renderSessionData();
    await settleInitialLoad(result, [serverMessage("m-1", "loaded")]);
    expect(result.current.initialApprovals).toEqual([pendingApproval]);

    rerender({ sessionId: null });

    expect(result.current.messages).toEqual([]);
    expect(result.current.artifacts).toEqual([]);
    expect(result.current.hasMoreMessages).toBe(false);
    expect(result.current.isSessionDataReady).toBe(false);
    expect(result.current.initialApprovals).toEqual([]);
  });

  it("keeps an uncached failed selection empty and reports the failure", async () => {
    const { result, onError } = renderSessionData();
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.reject(new Error("session unavailable"));
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith("session unavailable"));
    expect(result.current.messages).toEqual([]);
    expect(result.current.artifacts).toEqual([]);
    expect(result.current.isSessionDataReady).toBe(false);
  });

  it("does not let a refresh for another session supersede the selected session refresh", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    let refreshA!: Promise<void>;
    let refreshB!: Promise<void>;
    act(() => {
      refreshA = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    act(() => {
      refreshB = result.current.refreshSessionData("s-2");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(2));
    const [loadA, loadB] = apiState.pendingMessageLoads.splice(0, 2);

    await act(async () => {
      loadB?.resolve([serverMessage("b-1", "session B")]);
      await refreshB;
      loadA?.resolve([serverMessage("a-1", "session A")]);
      await refreshA;
    });

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(["session A"])
    );
  });

  it("makes the newest of two back-to-back refreshes authoritative", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refreshSessionData("s-1");
      second = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(2));
    const [older, newer] = apiState.pendingMessageLoads.splice(0, 2);

    await act(async () => {
      newer?.resolve([serverMessage("new", "newest call")]);
      await second;
      older?.resolve([serverMessage("old", "older call")]);
      await first;
    });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(["newest call"])
    );
  });

  it("writes completed artifact polling into the rendered session cache", async () => {
    const poll = deferredArtifacts();
    apiState.artifactResponses.push(
      Promise.resolve([artifact("pending", "processing")]),
      poll.promise
    );
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    await act(async () => {
      poll.resolve([artifact("ready", "ready")]);
    });

    await waitFor(() =>
      expect(result.current.artifacts.map((item) => item.artifactId)).toEqual(["ready"])
    );
  });

  it("discards a poll that started before a newer full refresh settled", async () => {
    const poll = deferredArtifacts();
    apiState.artifactResponses.push(
      Promise.resolve([artifact("pending", "processing")]),
      poll.promise
    );
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    apiState.artifactResponses.push(Promise.resolve([artifact("fresh", "ready")]));
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([]);
      await refresh;
    });
    await waitFor(() =>
      expect(result.current.artifacts.map((item) => item.artifactId)).toEqual(["fresh"])
    );

    await act(async () => {
      poll.resolve([artifact("stale", "ready")]);
    });
    expect(result.current.artifacts.map((item) => item.artifactId)).toEqual(["fresh"]);
  });

  it("does not let a switch-back poll mark a stale transcript ready", async () => {
    apiState.artifactResponses.push(
      Promise.resolve([artifact("pending-a", "processing")]),
      Promise.resolve([artifact("pending-a", "processing")])
    );
    const { result, rerender } = renderSessionData("s-1");
    await settleInitialLoad(result, [serverMessage("a-1", "cached A")]);
    await waitFor(() => expect(apiState.artifactResponses).toHaveLength(0));

    apiState.artifactResponses.push(Promise.resolve([]));
    rerender({ sessionId: "s-2" });
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("b-1", "session B")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));

    const switchBackPoll = deferredArtifacts();
    apiState.artifactResponses.push(
      Promise.resolve([artifact("pending-a", "processing")]),
      switchBackPoll.promise
    );
    rerender({ sessionId: "s-1" });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));
    await act(async () => {
      switchBackPoll.resolve([artifact("stale-poll", "ready")]);
    });

    expect(result.current.isSessionDataReady).toBe(false);
    expect(result.current.messages.map((message) => message.content)).toEqual(["cached A"]);

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.resolve([serverMessage("a-2", "fresh A")]);
    });
    await waitFor(() => expect(result.current.isSessionDataReady).toBe(true));
    expect(result.current.messages.map((message) => message.content)).toEqual(["fresh A"]);
  });

  it("discards a poll that starts while a full refresh is in flight", async () => {
    const fullArtifacts = deferredArtifacts();
    const latePoll = deferredArtifacts();
    apiState.artifactResponses.push(
      Promise.resolve([artifact("pending", "processing")]),
      Promise.resolve([artifact("pending", "processing")])
    );
    const { result, queryClient } = renderSessionData();
    await settleInitialLoad(result, []);
    await waitFor(() => expect(apiState.artifactResponses).toHaveLength(0));

    apiState.artifactResponses.push(fullArtifacts.promise, latePoll.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshSessionData("s-1");
    });
    await waitFor(() => expect(apiState.pendingMessageLoads).toHaveLength(1));

    let pollRefresh!: Promise<unknown>;
    act(() => {
      pollRefresh = queryClient.refetchQueries({
        queryKey: queryKeys.sessions.artifacts("s-1"),
        exact: true
      });
    });
    await waitFor(() => expect(apiState.artifactResponses).toHaveLength(0));

    await act(async () => {
      fullArtifacts.resolve([artifact("fresh", "ready")]);
      apiState.pendingMessageLoads.shift()?.resolve([]);
      await refresh;
    });
    await waitFor(() =>
      expect(result.current.artifacts.map((item) => item.artifactId)).toEqual(["fresh"])
    );

    await act(async () => {
      latePoll.resolve([artifact("stale", "ready")]);
      await pollRefresh;
    });
    expect(result.current.artifacts.map((item) => item.artifactId)).toEqual(["fresh"]);
  });
});
