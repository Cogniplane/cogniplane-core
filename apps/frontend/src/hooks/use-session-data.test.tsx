// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

import type { Message } from "@cogniplane/shared-types";

import { buildOptimisticMessage } from "./chat-message-state";
import { useSessionData } from "./use-session-data";

const apiState = vi.hoisted(() => ({
  pendingMessageLoads: [] as Array<(messages: unknown[]) => void>
}));

vi.mock("../lib/message-api", () => ({
  listMessages: vi.fn(
    () =>
      new Promise<unknown[]>((resolve) => {
        apiState.pendingMessageLoads.push(resolve);
      })
  )
}));

vi.mock("../lib/artifact-api", () => ({
  listArtifacts: vi.fn(async () => [])
}));

vi.mock("../lib/session-api", () => ({
  listApprovals: vi.fn(async () => [])
}));

function serverMessage(messageId: string, content: string): Message {
  return { ...buildOptimisticMessage({ sessionId: "s-1", role: "user", status: "completed", content }), messageId };
}

function renderSessionData() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  // Stable callbacks: the populate effect depends on replacePendingApprovals,
  // so a fresh fn per render would re-apply the query snapshot on every
  // rerender and mask the behavior under test.
  const onError = vi.fn();
  const replacePendingApprovals = vi.fn();

  return renderHook(
    () =>
      useSessionData({
        selectedSessionId: "s-1",
        onError,
        replacePendingApprovals
      }),
    { wrapper }
  );
}

async function settleInitialLoad(
  result: { current: ReturnType<typeof useSessionData> },
  resultMessages: Message[]
) {
  // The mounted useQuery issues the first listMessages call; settle it AND
  // wait for the populate effect to apply it (TanStack batches the query
  // notification, so the effect can land a tick after the resolve).
  await act(async () => {
    apiState.pendingMessageLoads.shift()?.(resultMessages);
  });
  await waitFor(() => {
    expect(result.current.isSessionDataReady).toBe(true);
    expect(result.current.messages).toHaveLength(resultMessages.length);
  });
}

describe("useSessionData: refreshSessionData vs in-flight sends", () => {
  beforeEach(() => {
    apiState.pendingMessageLoads.length = 0;
  });

  it("a refresh invalidated mid-flight does not wipe optimistic messages appended after it started", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, [serverMessage("m-1", "turn 1 question")]);

    // Post-turn refresh starts (its listMessages stays pending).
    let refreshDone: Promise<void> | null = null;
    act(() => {
      refreshDone = result.current.refreshSessionData("s-1");
    });

    // User sends the next message before the refresh lands: optimistic
    // bubbles appended, in-flight refreshes invalidated (what sendMessage
    // does).
    const optimistic = buildOptimisticMessage({
      sessionId: "s-1",
      role: "user",
      status: "completed",
      content: "turn 2 question"
    });
    act(() => {
      result.current.invalidateInFlightSessionRefreshes();
      result.current.setMessages((current) => [...current, optimistic]);
    });

    // The stale refresh lands with a snapshot that predates the new send.
    await act(async () => {
      apiState.pendingMessageLoads.shift()?.([
        serverMessage("m-1", "turn 1 question"),
        serverMessage("m-2", "turn 1 answer")
      ]);
      await refreshDone;
    });

    // The optimistic bubble must survive; the stale snapshot is discarded.
    expect(result.current.messages.map((m) => m.content)).toContain("turn 2 question");
  });

  it("a refresh that completes uninterrupted replaces messages with the server snapshot", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, [serverMessage("m-1", "turn 1 question")]);

    let refreshDone: Promise<void> | null = null;
    act(() => {
      refreshDone = result.current.refreshSessionData("s-1");
    });

    await act(async () => {
      apiState.pendingMessageLoads.shift()?.([
        serverMessage("m-1", "turn 1 question"),
        serverMessage("m-2", "turn 1 answer")
      ]);
      await refreshDone;
    });

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "turn 1 question",
      "turn 1 answer"
    ]);
  });

  it("overlapping refreshes resolve last-call-wins, not last-land-wins", async () => {
    const { result } = renderSessionData();
    await settleInitialLoad(result, []);

    let firstRefresh: Promise<void> | null = null;
    let secondRefresh: Promise<void> | null = null;
    act(() => {
      firstRefresh = result.current.refreshSessionData("s-1");
    });
    act(() => {
      secondRefresh = result.current.refreshSessionData("s-1");
    });

    const [resolveFirst, resolveSecond] = apiState.pendingMessageLoads.splice(0, 2);

    // The newer refresh lands first with newer data...
    await act(async () => {
      resolveSecond?.([serverMessage("m-new", "newer snapshot")]);
      await secondRefresh;
    });
    // ...then the older one lands with stale data and must be discarded.
    await act(async () => {
      resolveFirst?.([serverMessage("m-old", "stale snapshot")]);
      await firstRefresh;
    });

    expect(result.current.messages.map((m) => m.content)).toEqual(["newer snapshot"]);
  });
});
