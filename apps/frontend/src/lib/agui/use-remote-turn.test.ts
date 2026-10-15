// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listMessages: vi.fn(),
  listApprovals: vi.fn()
}));
vi.mock("../session-api", () => ({ listSessions: api.listSessions, listApprovals: api.listApprovals }));
vi.mock("../message-api", () => ({ listMessages: api.listMessages }));

import { REMOTE_TURN_POLL_MS, useRemoteTurnPoll } from "./use-remote-turn";

function serverReports(running: boolean, content = "partial") {
  api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "s-1", isRunning: running }], trashRetentionDays: 30 });
  api.listMessages.mockResolvedValue({ messages: [{ messageId: "m-1", role: "assistant", content }], hasMore: false });
  api.listApprovals.mockResolvedValue([]);
}

// Let the awaited API calls of one poll resolve.
async function flushPoll() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

type Props = { active: boolean; refresh: number };

// useSessionConnection makes the poll active while the turn runs on the
// server without a stream in this tab.
function renderPoll(initial: Props = { active: true, refresh: 0 }) {
  const onSnapshot = vi.fn();
  const onEnded = vi.fn();
  const view = renderHook((props: Props) => useRemoteTurnPoll({ sessionId: "s-1", ...props, onSnapshot, onEnded }), {
    initialProps: initial
  });
  return { ...view, onSnapshot, onEnded };
}

describe("useRemoteTurnPoll", () => {
  it("polls every 3 seconds while active, then reports the end once and stops", async () => {
    serverReports(true);
    const { onSnapshot, onEnded } = renderPoll();

    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledWith(expect.objectContaining({ ids: ["s-1"] }));
    expect(onSnapshot).toHaveBeenLastCalledWith({
      messages: [expect.objectContaining({ content: "partial" })],
      approvals: []
    });

    serverReports(false, "final");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS - 1);
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushPoll();

    expect(onSnapshot).toHaveBeenLastCalledWith({
      messages: [expect.objectContaining({ content: "final" })],
      approvals: []
    });
    expect(onEnded).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS * 3);
    });
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("reads only the current turn after the first snapshot", async () => {
    api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "s-1", isRunning: true }] });
    api.listApprovals.mockResolvedValue([]);
    api.listMessages
      .mockResolvedValueOnce({ messages: [
        { messageId: "old", role: "assistant", content: "old" },
        { messageId: "user", role: "user", content: "question" },
        { messageId: "answer", role: "assistant", content: "partial" }
      ] })
      .mockResolvedValueOnce({ messages: [
        { messageId: "user", role: "user", content: "question" },
        { messageId: "answer", role: "assistant", content: "more" }
      ] });
    const { onSnapshot } = renderPoll();
    await flushPoll();
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS); });
    await flushPoll();
    expect(api.listMessages).toHaveBeenNthCalledWith(2, "s-1", expect.any(AbortSignal), { since: "user" });
    expect(onSnapshot).toHaveBeenLastCalledWith({
      messages: [
        expect.objectContaining({ messageId: "old" }),
        expect.objectContaining({ messageId: "user" }),
        expect.objectContaining({ content: "more" })
      ],
      approvals: []
    });
    expect(api.listApprovals).toHaveBeenCalledTimes(2);
  });

  it("reloads the full snapshot if a tail loses its anchor", async () => {
    api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "s-1", isRunning: true }] });
    api.listApprovals.mockResolvedValue([]);
    api.listMessages
      .mockResolvedValueOnce({ messages: [{ messageId: "user", role: "user" }] })
      .mockResolvedValueOnce({ messages: [{ messageId: "other", role: "assistant" }] })
      .mockResolvedValueOnce({ messages: [{ messageId: "final", role: "assistant" }] });
    const { onSnapshot } = renderPoll();
    await flushPoll();
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS); });
    await flushPoll();
    expect(api.listMessages).toHaveBeenCalledTimes(3);
    expect(onSnapshot).toHaveBeenLastCalledWith({ messages: [expect.objectContaining({ messageId: "final" })], approvals: [] });
  });

  it("does not poll while inactive, and stops when it becomes inactive", async () => {
    serverReports(true);
    const { rerender, onEnded } = renderPoll({ active: false, refresh: 0 });
    rerender({ active: false, refresh: 1 });
    await flushPoll();
    expect(api.listSessions).not.toHaveBeenCalled();

    rerender({ active: true, refresh: 1 });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledOnce();
    rerender({ active: false, refresh: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS * 3);
    });
    expect(api.listSessions).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("polls at once on a new refresh value, and restarts its interval", async () => {
    serverReports(true);
    const { rerender } = renderPoll();
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    rerender({ active: true, refresh: 1 });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS);
    });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(3);
  });

  it("ignores a read that returns after a newer poll started", async () => {
    let answerStale!: (value: unknown) => void;
    api.listSessions
      .mockImplementationOnce(() => new Promise((resolve) => { answerStale = resolve; }))
      .mockResolvedValue({ sessions: [{ sessionId: "s-1", isRunning: true }] });
    api.listMessages.mockResolvedValue({ messages: [{ messageId: "fresh", role: "assistant" }] });
    api.listApprovals.mockResolvedValue([]);
    const { rerender, onSnapshot, onEnded } = renderPoll();

    rerender({ active: true, refresh: 1 });
    await flushPoll();
    expect(onSnapshot).toHaveBeenCalledOnce();
    api.listMessages.mockResolvedValue({ messages: [{ messageId: "stale", role: "assistant" }] });
    await act(async () => { answerStale({ sessions: [{ sessionId: "s-1", isRunning: false }] }); });
    await flushPoll();

    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("keeps polling after a failed poll", async () => {
    api.listSessions.mockRejectedValueOnce(new Error("network"));
    const { onSnapshot } = renderPoll();
    await flushPoll();
    expect(onSnapshot).not.toHaveBeenCalled();

    serverReports(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS);
    });
    await flushPoll();
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  it("stops polling on unmount", async () => {
    serverReports(true);
    const { unmount } = renderPoll();
    await flushPoll();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS * 3);
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });
});
