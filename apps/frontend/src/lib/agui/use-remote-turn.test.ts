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

import { REMOTE_TURN_POLL_MS, useRemoteTurn } from "./use-remote-turn";

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

type Props = { serverRunning: boolean; localRunning: boolean };

function renderRemoteTurn(initial: Props) {
  const onSnapshot = vi.fn();
  const onSettled = vi.fn();
  const view = renderHook((props: Props) => useRemoteTurn({ sessionId: "s-1", ...props, onSnapshot, onSettled }), {
    initialProps: initial
  });
  return { ...view, onSnapshot, onSettled };
}

describe("useRemoteTurn", () => {
  it("polls a turn that runs at mount every 3 seconds, then settles once when it ends", async () => {
    serverReports(true);
    const { result, onSnapshot, onSettled } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    expect(result.current.isRemoteRunning).toBe(true);

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
    expect(result.current.isRemoteRunning).toBe(false);
    expect(onSettled).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS * 3);
    });
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("does not poll while this tab streams the turn", async () => {
    serverReports(true);
    const { result } = renderRemoteTurn({ serverRunning: true, localRunning: true });
    await flushPoll();
    expect(result.current.isRemoteRunning).toBe(false);
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("enters when the saved state changes to running, not on a stale steady value", async () => {
    serverReports(true);
    const { result, rerender } = renderRemoteTurn({ serverRunning: true, localRunning: true });
    // This tab's own turn ends while the list still shows it running.
    rerender({ serverRunning: true, localRunning: false });
    expect(result.current.isRemoteRunning).toBe(false);

    rerender({ serverRunning: false, localRunning: false });
    rerender({ serverRunning: true, localRunning: false });
    expect(result.current.isRemoteRunning).toBe(true);
  });

  it("enters on request, for a send the backend refused as busy", async () => {
    serverReports(true);
    const { result } = renderRemoteTurn({ serverRunning: false, localRunning: false });
    expect(result.current.isRemoteRunning).toBe(false);
    act(() => result.current.enterRemoteRunning());
    expect(result.current.isRemoteRunning).toBe(true);
    await flushPoll();
    expect(api.listMessages).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
    expect(api.listApprovals).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
  });

  it("polls at once on request when the mode is already on", async () => {
    serverReports(true);
    const { result } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    act(() => result.current.enterRemoteRunning());
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(2);

    // The request restarts the interval, so only one poll follows it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS);
    });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(3);
  });

  it("refreshes at once and settles when the server no longer reports the turn", async () => {
    serverReports(true);
    const { result, onSettled } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    // The saved list still shows the turn, but the server has no running turn.
    serverReports(false);
    act(() => result.current.refreshRemoteTurn());
    await flushPoll();

    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(result.current.isRemoteRunning).toBe(false);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("does not enter the mode on a refresh", async () => {
    serverReports(true);
    const { result } = renderRemoteTurn({ serverRunning: false, localRunning: false });
    act(() => result.current.refreshRemoteTurn());
    await flushPoll();
    expect(result.current.isRemoteRunning).toBe(false);
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("keeps polling after a failed poll", async () => {
    api.listSessions.mockRejectedValueOnce(new Error("network"));
    const { result, onSnapshot } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    await flushPoll();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(result.current.isRemoteRunning).toBe(true);

    serverReports(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS);
    });
    await flushPoll();
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  it("polls at once when the saved state changes to done", async () => {
    serverReports(true);
    const { result, rerender, onSettled } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    serverReports(false);
    rerender({ serverRunning: false, localRunning: false });
    await flushPoll();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(result.current.isRemoteRunning).toBe(false);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("stops polling on unmount", async () => {
    serverReports(true);
    const { unmount } = renderRemoteTurn({ serverRunning: true, localRunning: false });
    await flushPoll();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_TURN_POLL_MS * 3);
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });
});
