// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusIfOwned, keepFocusVisible, ownsFocus } from "./focus-ownership";

function button(parent: HTMLElement = document.body) {
  return parent.appendChild(document.createElement("button"));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("ownsFocus", () => {
  it("owns body and null focus with or without origins", () => {
    const origin = button();
    expect(ownsFocus()).toBe(true);
    expect(ownsFocus({ origins: [origin] })).toBe(true);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    expect(ownsFocus()).toBe(true);
    expect(ownsFocus({ origins: [origin] })).toBe(true);
  });

  it("owns exact origins and ignores missing origins", () => {
    const origin = button();
    const other = button();
    origin.focus();
    expect(ownsFocus()).toBe(false);
    expect(ownsFocus({ origins: [null, other, undefined, origin] })).toBe(true);
    other.focus();
    expect(ownsFocus({ origins: [null, undefined, origin] })).toBe(false);
  });

  it("does not own a descendant of an origin", () => {
    const origin = document.body.appendChild(document.createElement("div"));
    button(origin).focus();
    expect(ownsFocus({ origins: [origin] })).toBe(false);
  });

  it("owns a scope and its descendants, but leaves outside focus alone", () => {
    const scope = document.body.appendChild(document.createElement("section"));
    scope.tabIndex = -1;
    scope.focus();
    expect(ownsFocus({ scope })).toBe(true);
    button(scope).focus();
    expect(ownsFocus({ scope })).toBe(true);
    expect(ownsFocus({ scope: null })).toBe(false);
    button().focus();
    expect(ownsFocus({ scope })).toBe(false);
  });

  it("owns a disconnected active element only when requested or listed as an origin", () => {
    const removed = document.createElement("button");
    vi.spyOn(document, "activeElement", "get").mockReturnValue(removed);
    expect(ownsFocus()).toBe(false);
    expect(ownsFocus({ disconnectedIsLost: false })).toBe(false);
    expect(ownsFocus({ disconnectedIsLost: true })).toBe(true);
    expect(ownsFocus({ origins: [removed] })).toBe(true);
  });

  it("can check a supplied active element", () => {
    const origin = button();
    const other = button();
    origin.focus();
    expect(ownsFocus({ origins: [origin] }, other)).toBe(false);
    expect(ownsFocus({ origins: [origin] }, null)).toBe(true);
  });
});

describe("focusIfOwned", () => {
  it("uses browser focus scrolling and reports when focus lands", () => {
    const target = button();
    const focus = vi.spyOn(target, "focus");
    expect(focusIfOwned(target)).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not take focus from another control", () => {
    const target = button();
    const other = button();
    const focus = vi.spyOn(target, "focus");
    other.focus();
    expect(focusIfOwned(target)).toBe(false);
    expect(document.activeElement).toBe(other);
    expect(focus).not.toHaveBeenCalled();
  });

  it("moves focus from an owned origin", () => {
    const origin = button();
    const target = button();
    origin.focus();
    expect(focusIfOwned(target, { origins: [origin] })).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  it("supports the auth scope rule without taking focus outside that scope", () => {
    const scope = document.body.appendChild(document.createElement("section"));
    const origin = button(scope);
    const target = button(scope);
    const ownership = { scope, disconnectedIsLost: true };
    origin.focus();
    expect(focusIfOwned(target, ownership)).toBe(true);
    const other = button();
    other.focus();
    expect(focusIfOwned(target, ownership)).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("ignores null, undefined and disconnected targets", () => {
    const target = document.createElement("button");
    const focus = vi.spyOn(target, "focus");
    expect(focusIfOwned(null)).toBe(false);
    expect(focusIfOwned(undefined)).toBe(false);
    expect(focusIfOwned(target)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("reports failure when an owned target is disabled", () => {
    const target = button();
    target.disabled = true;
    expect(focusIfOwned(target)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("keepFocusVisible", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextId: number;

  function advanceFrame() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }

  function offscreenTarget(top = -1, bottom = 20) {
    const target = button();
    target.focus();
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top, bottom } as DOMRect);
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    return { target, scroll };
  }

  beforeEach(() => {
    frames = new Map();
    nextId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
    vi.stubGlobal("innerHeight", 800);
  });

  it.each([1, 2] as const)("waits %i frames and passes the caller's scroll options unchanged", count => {
    const { target, scroll } = offscreenTarget();
    const options: ScrollIntoViewOptions = count === 1
      ? { block: "nearest", behavior: "instant" }
      : { block: "center", inline: "nearest", behavior: "instant" };
    keepFocusVisible(target, { frames: count, scroll: options });
    expect(scroll).not.toHaveBeenCalled();
    if (count === 2) {
      advanceFrame();
      expect(scroll).not.toHaveBeenCalled();
    }
    advanceFrame();
    expect(scroll).toHaveBeenCalledExactlyOnceWith(options);
    expect(scroll.mock.calls[0][0]).toBe(options);
    expect(frames.size).toBe(0);
  });

  it.each([
    { top: 4, bottom: 796, expected: 0 },
    { top: 3.9, bottom: 796, expected: 1 },
    { top: 4, bottom: 796.1, expected: 1 }
  ])("uses a 4px viewport inset for top $top and bottom $bottom", ({ top, bottom, expected }) => {
    const { target, scroll } = offscreenTarget(top, bottom);
    keepFocusVisible(target, { frames: 1, scroll: { block: "nearest" } });
    advanceFrame();
    expect(scroll).toHaveBeenCalledTimes(expected);
  });

  it("reads the target's current position on the last frame", () => {
    const { target, scroll } = offscreenTarget(4, 796);
    keepFocusVisible(target, { frames: 2, scroll: { block: "center" } });
    advanceFrame();
    vi.mocked(target.getBoundingClientRect).mockReturnValue({ top: -1, bottom: 20 } as DOMRect);
    advanceFrame();
    expect(scroll).toHaveBeenCalledOnce();
  });

  it("keeps later focus and does not scroll the old target", () => {
    const { target, scroll } = offscreenTarget();
    keepFocusVisible(target, { frames: 2, scroll: { block: "center" } });
    advanceFrame();
    const other = button();
    other.focus();
    advanceFrame();
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });

  it("ignores a removed target even if the document still reports it as focused", () => {
    const { target, scroll } = offscreenTarget();
    keepFocusVisible(target, { frames: 2, scroll: { block: "center" } });
    advanceFrame();
    target.remove();
    vi.spyOn(document, "activeElement", "get").mockReturnValue(target);
    advanceFrame();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([0, 1])("cancels the pending frame after %i frames", elapsed => {
    const { target, scroll } = offscreenTarget();
    const cancel = keepFocusVisible(target, { frames: 2, scroll: { block: "center" } });
    if (elapsed === 1) advanceFrame();
    const pendingId = [...frames.keys()][0];
    cancel();
    cancel();
    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(pendingId);
    advanceFrame();
    advanceFrame();
    expect(scroll).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("does nothing when cancelled after completion", () => {
    const { target, scroll } = offscreenTarget();
    const cancel = keepFocusVisible(target, { frames: 1, scroll: { block: "nearest" } });
    advanceFrame();
    cancel();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledOnce();
  });

  it("tolerates a missing scrollIntoView method", () => {
    const { target } = offscreenTarget();
    Reflect.deleteProperty(target, "scrollIntoView");
    keepFocusVisible(target, { frames: 1, scroll: { block: "nearest" } });
    expect(advanceFrame).not.toThrow();
  });
});
