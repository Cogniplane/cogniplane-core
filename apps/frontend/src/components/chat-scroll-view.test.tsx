// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";

const { scrollToBottom } = vi.hoisted(() => ({ scrollToBottom: vi.fn() }));
vi.mock("@copilotkit/react-core/v2", async () => {
  const { useState } = await import("react");
  return { CopilotChatView: {
    ScrollToBottomButton: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props} data-testid="copilot-scroll-to-bottom">Latest</button>
    ),
    ScrollView: ({ children, scrollToBottomButton: Button, isResizing }: {
      children: ReactNode; scrollToBottomButton: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>; isResizing: boolean;
    }) => {
      const [atBottom, setAtBottom] = useState(false);
      return <>{children}{!atBottom && !isResizing && <Button onClick={(event) => {
        scrollToBottom(event);
        if (!event.defaultPrevented) setAtBottom(true);
      }} />}</>;
    }
  } };
});

import { ChatScrollView } from "./chat-scroll-view";
import * as caret from "../lib/textarea-caret";

let height = 260;
let measure: () => void;
let measurements: Array<() => void>;
const disconnect = vi.fn();
beforeEach(() => {
  height = 260;
  measurements = [];
  scrollToBottom.mockReset();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback; measurements.push(callback); }
    observe() {}
    unobserve() {}
    disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const view = (overlay: number, isResizing = false) => (
  <div data-testid="copilot-chat">
    <ChatScrollView inputContainerHeight={overlay} isResizing={isResizing}><textarea aria-label="Generated notes" /></ChatScrollView>
    <textarea aria-label="Message" data-testid="copilot-chat-textarea" />
  </div>
);
const button = () => screen.getByTestId("copilot-scroll-to-bottom");

it("hides the entire control when its body and ring cannot fit, then restores it after resize", () => {
  render(view(200));
  expect(button().style.visibility).toBe("visible");
  height = 259;
  act(() => measure());
  expect(button().style.visibility).toBe("hidden");
  expect(screen.queryByRole("button")).toBeNull();
  height = 260;
  act(() => measure());
  expect(button().style.visibility).toBe("visible");
});

it("rechecks the fit when the composer grows and returns its focused control to Message", () => {
  const { rerender } = render(view(200));
  button().focus();
  rerender(view(201));
  expect(button().style.visibility).toBe("hidden");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
});

it("keeps other focus in place and disconnects on unmount", () => {
  const { rerender, unmount } = render(view(200));
  screen.getByRole("textbox", { name: "Generated notes" }).focus();
  rerender(view(270));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Generated notes" }));
  unmount();
  expect(disconnect).toHaveBeenCalled();
});

it("keeps the usable control and its focus during the SDK resize pause", () => {
  const { rerender } = render(view(200));
  button().focus();
  rerender(view(200, true));
  expect(button().style.visibility).toBe("visible");
  expect(document.activeElement).toBe(button());
  rerender(view(200));
  expect(button().style.visibility).toBe("visible");
  expect(document.activeElement).toBe(button());
});

it("keeps the SDK action and moves focus to Message before removal", () => {
  render(view(200));
  button().focus();
  fireEvent.click(button());
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("copilot-scroll-to-bottom")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
});

it("does not take focus back when the action moves it elsewhere", () => {
  render(view(200));
  scrollToBottom.mockImplementation(() => screen.getByRole("textbox", { name: "Generated notes" }).focus());
  button().focus();
  fireEvent.click(button());
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Generated notes" }));
});

it("respects an action that prevents activation", () => {
  render(view(200));
  scrollToBottom.mockImplementation((event) => event.preventDefault());
  button().focus();
  fireEvent.click(button());
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button());
});

it("does not move unrelated focus after an unfocused activation", () => {
  render(view(200));
  screen.getByRole("textbox", { name: "Generated notes" }).focus();
  fireEvent.click(button());
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Generated notes" }));
});

function focusFixture() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  render(<div data-chat-host data-testid="host"><div data-chat-transcript-frame data-testid="frame">
    <div data-testid="copilot-chat">
      <ChatScrollView inputContainerHeight={200}>
        <div data-testid="scroller" style={{ overflowY: "auto" }}>
          <div data-testid="content" style={{ overflowY: "auto" }}><textarea aria-label="Generated notes" /></div>
        </div>
      </ChatScrollView>
      <textarea aria-label="Message" data-testid="copilot-chat-textarea" />
    </div>
  </div></div>);
  const scroller = screen.getByTestId("scroller");
  const content = screen.getByTestId("content");
  const notes = screen.getByRole("textbox", { name: "Generated notes" });
  vi.spyOn(screen.getByTestId("host"), "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 600, height: 600 } as DOMRect);
  Object.defineProperties(scroller, { clientHeight: { value: 300, configurable: true }, scrollHeight: { value: 1000 } });
  Object.defineProperties(content, { clientHeight: { value: 1000 }, scrollHeight: { value: 1000 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => ({ top: 100, bottom: 400, height: 300 }) as DOMRect);
  let contentTop = 250;
  vi.spyOn(notes, "getBoundingClientRect").mockImplementation(() => {
    const height = Math.min(64, parseFloat(notes.style.maxHeight) || 64);
    return { top: contentTop - scroller.scrollTop, bottom: contentTop - scroller.scrollTop + height, height } as DOMRect;
  });
  scroller.scrollTop = 100;
  const flush = () => act(() => { for (const callback of frames.splice(0)) callback(0); });
  return { notes, scroller, content, flush, moveTo: (top: number) => { contentTop = top; } };
}

it("reveals a focused field in its overflowing ancestor and keeps it visible after resize and host clipping", () => {
  const { notes, scroller, content, flush, moveTo } = focusFixture();
  const before = scroller.scrollTop;
  act(() => notes.focus()); flush();
  expect(scroller.scrollTop).toBeGreaterThan(before);
  expect(content.scrollTop).toBe(0);
  const frame = screen.getByTestId("frame");
  expect(parseFloat(frame.style.getPropertyValue("--transcript-focus-floor"))).toBeGreaterThan(0);
  expect(parseFloat(frame.style.getPropertyValue("--transcript-focus-room"))).toBeGreaterThan(notes.getBoundingClientRect().height);
  expect(button().style.visibility).toBe("hidden");
  expect(document.activeElement).toBe(notes);

  const revealed = scroller.scrollTop;
  moveTo(150);
  act(() => window.dispatchEvent(new Event("resize"))); flush();
  expect(scroller.scrollTop).toBeLessThan(revealed);
  // The focus ring needs 4px above the field.
  expect(notes.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().top + 4);
  expect(notes.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().bottom);
  expect(document.activeElement).toBe(notes);

  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  vi.mocked(scroller.getBoundingClientRect).mockReturnValue({ top: 100, bottom: 600, height: 500 } as DOMRect);
  const host = screen.getByTestId("host");
  vi.mocked(host.getBoundingClientRect).mockReturnValue({ top: 180, bottom: 600, height: 420 } as DOMRect);
  act(() => window.dispatchEvent(new Event("resize"))); flush();
  expect(notes.getBoundingClientRect().top).toBeGreaterThanOrEqual(host.getBoundingClientRect().top + 4);
  expect(notes.getBoundingClientRect().bottom).toBeLessThanOrEqual(host.getBoundingClientRect().bottom);
  expect(document.activeElement).toBe(notes);
});

it("allows deliberate transcript scrolling and does not pull outside focus back", () => {
  const { notes, scroller, flush, moveTo } = focusFixture();
  act(() => notes.focus());
  flush();
  fireEvent.wheel(scroller);
  const readingPosition = scroller.scrollTop + 100;
  scroller.scrollTop = readingPosition;
  fireEvent.scroll(scroller);
  flush();
  expect(scroller.scrollTop).toBe(readingPosition);
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  moveTo(500);
  act(() => measurements.forEach(callback => callback()));
  flush();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  expect(scroller.scrollTop).toBe(readingPosition);
  expect(screen.getByTestId("frame").style.getPropertyValue("--transcript-focus-room")).toBe("0px");
  expect(button().style.visibility).toBe("visible");
});

it("leaves the textarea caret alone during deliberate reading and reveals it again on a field key", () => {
  const reveal = vi.spyOn(caret, "revealTextareaCaret");
  const { notes, scroller, flush } = focusFixture();
  act(() => notes.focus());
  flush();
  expect(reveal).toHaveBeenCalledWith(notes);
  reveal.mockClear();
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);
  flush();
  expect(reveal).not.toHaveBeenCalled();
  fireEvent.keyDown(notes, { key: "Home" });
  flush();
  expect(reveal).toHaveBeenCalledWith(notes);
});

it("releases the focused-control reserve when focus leaves for the page", () => {
  const { notes, flush } = focusFixture();
  act(() => notes.focus());
  flush();
  act(() => notes.blur());
  flush();
  expect(screen.getByTestId("frame").style.getPropertyValue("--transcript-focus-room")).toBe("0px");
  expect(button().style.visibility).toBe("visible");
  expect(document.activeElement).toBe(document.body);
});

it("reveals an extended frame on field interaction, respects reading and caps the field to the visible host", () => {
  const { notes, scroller, flush } = focusFixture();
  const host = screen.getByTestId("host");
  const frame = screen.getByTestId("frame");
  vi.mocked(host.getBoundingClientRect).mockReturnValue({ top: 0, bottom: 400 } as DOMRect);
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({ bottom: 480 - host.scrollTop }) as DOMRect);
  notes.style.setProperty("min-height", "64px");
  notes.style.setProperty("max-height", "192px", "important");
  const original = { min: notes.style.minHeight, max: notes.style.maxHeight };
  const before = host.scrollTop;
  act(() => notes.focus()); flush();
  expect(host.scrollTop).toBeGreaterThan(before);
  expect(frame.getBoundingClientRect().bottom).toBeLessThanOrEqual(host.getBoundingClientRect().bottom);
  expect(document.activeElement).toBe(notes);

  fireEvent.wheel(scroller);
  host.scrollTop = before;
  fireEvent.scroll(scroller); flush();
  expect(host.scrollTop).toBe(before);
  fireEvent.keyDown(notes, { key: "Home" }); flush();
  expect(host.scrollTop).toBeGreaterThan(before);
  fireEvent.wheel(scroller);
  host.scrollTop = before;
  fireEvent.input(notes, { target: { value: "Changed notes" } }); flush();
  expect(host.scrollTop).toBeGreaterThan(before);

  const clip = { top: 42.5, bottom: 240, height: 197.5 } as DOMRect;
  vi.mocked(host.getBoundingClientRect).mockReturnValue(clip);
  act(() => window.dispatchEvent(new Event("resize"))); flush();
  expect(parseFloat(notes.style.maxHeight)).toBeLessThan(parseFloat(original.min));
  expect(parseFloat(notes.style.maxHeight)).toBeGreaterThan(0);
  expect(parseFloat(notes.style.maxHeight)).toBeLessThan(clip.height);
  expect(notes.style.minHeight).toBe(notes.style.maxHeight);
  expect(document.activeElement).toBe(notes);

  vi.mocked(host.getBoundingClientRect).mockReturnValue({ top: 0, bottom: 600, height: 600 } as DOMRect);
  act(() => window.dispatchEvent(new Event("resize"))); flush();
  expect(notes.style.minHeight).toBe(original.min);
  expect(notes.style.maxHeight).toBe(original.max);
  const scroll = host.scrollTop;
  act(() => screen.getByRole("textbox", { name: "Message" }).focus()); flush();
  expect(host.scrollTop).toBe(scroll);
  expect(notes.style.minHeight).toBe(original.min);
  expect(notes.style.getPropertyPriority("min-height")).toBe("");
  expect(notes.style.maxHeight).toBe(original.max);
  expect(notes.style.getPropertyPriority("max-height")).toBe("important");
});
