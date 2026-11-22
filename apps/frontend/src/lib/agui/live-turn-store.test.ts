// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveTurnStore, useLiveTurn, type LiveTurn } from "./live-turn-store";

afterEach(cleanup);

const turn = (fields: Partial<LiveTurn> = {}): LiveTurn => ({
  running: false, activity: null, pendingApprovals: null, settling: false, ...fields
});

describe("LiveTurnStore", () => {
  it("gives the record only to the session that wrote it", () => {
    const store = new LiveTurnStore();
    store.publish("s-1", turn({ running: true, pendingApprovals: 2 }));

    expect(store.read("s-1")).toMatchObject({ running: true, pendingApprovals: 2 });
    expect(store.read("s-2")).toBeNull();
    expect(store.read(null)).toBeNull();
  });

  it("tells its readers about a change, and not about an equal record", () => {
    const store = new LiveTurnStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.publish("s-1", turn({ running: true }));
    const first = store.read("s-1");
    store.publish("s-1", turn({ running: true }));
    expect(listener).toHaveBeenCalledOnce();
    expect(store.read("s-1")).toBe(first);

    store.publish("s-1", turn({ running: false }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.clear("s-1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the record of the next session when the old chat clears late", () => {
    const store = new LiveTurnStore();
    store.publish("s-1", turn({ running: true }));
    store.publish("s-2", turn({ pendingApprovals: 1 }));
    store.clear("s-1");

    expect(store.read("s-2")).toMatchObject({ pendingApprovals: 1 });
    store.clear("s-2");
    expect(store.read("s-2")).toBeNull();
  });
});

describe("useLiveTurn", () => {
  it("follows the selected session, and never shows the record of another one", () => {
    const store = new LiveTurnStore();
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useLiveTurn(store, id), {
      initialProps: { id: "s-1" as string | null }
    });
    expect(result.current).toBeNull();

    act(() => store.publish("s-1", turn({ running: true })));
    expect(result.current?.running).toBe(true);

    // The old chat still streams when the selection changes.
    rerender({ id: "s-2" });
    expect(result.current).toBeNull();
    act(() => store.publish("s-1", turn({ running: true, pendingApprovals: 3 })));
    expect(result.current).toBeNull();

    act(() => store.publish("s-2", turn({ settling: true })));
    expect(result.current).toMatchObject({ running: false, settling: true });
  });
});
