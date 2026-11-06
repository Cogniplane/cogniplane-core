"use client";

import { CopilotChatView } from "@copilotkit/react-core/v2";
import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { revealTextareaCaret } from "../lib/textarea-caret";

const ScrollButtonVisibility = createContext(true);

function ScrollToBottomButton({ onClick, style, ...props }: ComponentProps<typeof CopilotChatView.ScrollToBottomButton>) {
  const visible = useContext(ScrollButtonVisibility);
  return (
    <CopilotChatView.ScrollToBottomButton
      {...props}
      style={{ ...style, visibility: visible ? "visible" : "hidden" }}
      onClick={(event) => {
        const button = event.currentTarget;
        const ownedFocus = document.activeElement === button;
        onClick?.(event);
        // The SDK removes this button when scrolling reaches the bottom.
        // Keep the next keyboard action in Message instead of on the page.
        if (ownedFocus && !event.defaultPrevented && document.activeElement === button) {
          button.closest('[data-testid="copilot-chat"]')
            ?.querySelector<HTMLTextAreaElement>('[data-testid="copilot-chat-textarea"]')
            ?.focus({ preventScroll: true });
        }
      }}
    />
  );
}

// The SDK places its 40px scroll button 16px above the input overlay. Keep
// another 4px above it for the focus ring. A short transcript must not expose
// a clickable fragment under the toolbar when the composer grows.
export function ChatScrollView(props: ComponentProps<typeof CopilotChatView.ScrollView>) {
  const anchor = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState(false);
  const [contentHasFocus, setContentHasFocus] = useState(false);
  const fits = height >= (props.inputContainerHeight ?? 0) + 60 && !contentHasFocus;
  useLayoutEffect(() => {
    const root = anchor.current;
    const frame = root?.closest<HTMLElement>("[data-chat-transcript-frame]");
    if (!root || !frame) return;
    const host = frame.closest<HTMLElement>("[data-chat-host]");
    const overlay = props.inputContainerHeight ?? 0;
    let focused: HTMLElement | null = null;
    let fieldSize: { element: HTMLTextAreaElement; min: string; max: string; minPriority: string; maxPriority: string; minPixels: number; maxPixels: number } | null = null;
    const restoreFieldSize = () => {
      if (!fieldSize) return;
      const { element, min, max, minPriority, maxPriority } = fieldSize;
      if (min) element.style.setProperty("min-height", min, minPriority);
      else element.style.removeProperty("min-height");
      if (max) element.style.setProperty("max-height", max, maxPriority);
      else element.style.removeProperty("max-height");
      fieldSize = null;
    };
    const hostBounds = () => {
      const box = host?.getBoundingClientRect();
      return { top: Math.max(0, box?.top ?? 0), bottom: Math.min(window.innerHeight, box?.bottom ?? window.innerHeight) };
    };
    let pendingFrame = 0;
    let keepVisible = true;
    const reveal = () => {
      if (!keepVisible || !focused || document.activeElement !== focused) return;
      if (focused instanceof HTMLTextAreaElement) revealTextareaCaret(focused);
      // Scroll the upper bands away before revealing transcript content. The
      // composer and the focused control share the remaining window height.
      if (host) {
        const delta = frame.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom;
        if (delta > 0) host.scrollTop += delta;
      }
      for (let scroller = focused.parentElement; scroller && root.contains(scroller); scroller = scroller.parentElement) {
        if (!/auto|scroll/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight) continue;
        const clip = scroller.getBoundingClientRect();
        const box = focused.getBoundingClientRect();
        const bounds = hostBounds();
        const top = Math.max(clip.top + scroller.clientTop, bounds.top) + 4;
        const bottom = Math.min(clip.top + scroller.clientTop + scroller.clientHeight, bounds.bottom) - overlay - 4;
        const delta = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
        if (delta) scroller.scrollTop += delta;
        break;
      }
      const box = focused.getBoundingClientRect();
      const bounds = hostBounds();
      if (!host && (box.top < bounds.top + 4 || box.bottom > bounds.bottom - 4)) {
        focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    };
    const scheduleReveal = () => {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        reveal();
        pendingFrame = requestAnimationFrame(reveal);
      });
    };
    const measure = () => {
      const active = document.activeElement;
      const next = active instanceof HTMLElement && root.contains(active) && active.dataset.testid !== "copilot-scroll-to-bottom" ? active : null;
      if (focused !== next) {
        if (focused) observer.unobserve(focused);
        restoreFieldSize();
        focused = next;
        if (focused instanceof HTMLTextAreaElement) {
          const style = getComputedStyle(focused);
          fieldSize = {
            element: focused,
            min: focused.style.getPropertyValue("min-height"), max: focused.style.getPropertyValue("max-height"),
            minPriority: focused.style.getPropertyPriority("min-height"), maxPriority: focused.style.getPropertyPriority("max-height"),
            minPixels: parseFloat(style.minHeight) || 0, maxPixels: parseFloat(style.maxHeight) || Infinity
          };
        }
        if (focused) observer.observe(focused);
      }
      if (fieldSize) {
        const bounds = hostBounds();
        // A short host cannot hold a full multiline field and the composer.
        // Keep one editable row, and let the field scroll its own text.
        const limit = Math.min(fieldSize.maxPixels, Math.max(36, bounds.bottom - bounds.top - 148 - 8));
        fieldSize.element.style.setProperty("min-height", `${Math.min(fieldSize.minPixels, limit)}px`, "important");
        fieldSize.element.style.setProperty("max-height", `${limit}px`, "important");
      }
      // Keep a field's full height and ring, plus 148px for the composer.
      // Its accessory region can scroll instead of extending below the host.
      const room = focused ? Math.max(48, focused.getBoundingClientRect().height + 8) : 0;
      frame.style.setProperty("--transcript-focus-room", `${room}px`);
      frame.style.setProperty("--transcript-focus-floor", `${148 + room}px`);
      setContentHasFocus(Boolean(focused));
      keepVisible = true;
      scheduleReveal();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    if (host) observer.observe(host);
    const onFocusOut = () => {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(measure);
    };
    const stopFollowing = () => { keepVisible = false; };
    const onFieldInput = (event: Event) => {
      if (event.target !== focused || !(focused instanceof HTMLTextAreaElement)) return;
      keepVisible = true;
      scheduleReveal();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Caret movement and editing scroll inside the field. They must not
      // release the composer while the field still owns keyboard focus.
      if (event.target instanceof HTMLTextAreaElement) {
        keepVisible = true;
        scheduleReveal();
        return;
      }
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) stopFollowing();
    };
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("scroll", scheduleReveal, true);
    root.addEventListener("pointerdown", stopFollowing);
    root.addEventListener("wheel", stopFollowing, { passive: true });
    root.addEventListener("touchstart", stopFollowing, { passive: true });
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("input", onFieldInput);
    window.addEventListener("resize", measure);
    // Focus can leave this subtree without another focusin inside it.
    document.addEventListener("focusin", measure);
    measure();
    return () => {
      observer.disconnect();
      restoreFieldSize();
      cancelAnimationFrame(pendingFrame);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("scroll", scheduleReveal, true);
      root.removeEventListener("pointerdown", stopFollowing);
      root.removeEventListener("wheel", stopFollowing);
      root.removeEventListener("touchstart", stopFollowing);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("input", onFieldInput);
      window.removeEventListener("resize", measure);
      document.removeEventListener("focusin", measure);
      frame.style.removeProperty("--transcript-focus-floor");
      frame.style.removeProperty("--transcript-focus-room");
    };
  }, [props.inputContainerHeight]);
  useLayoutEffect(() => {
    const chat = anchor.current?.closest<HTMLElement>('[data-testid="copilot-chat"]');
    if (!chat) return;
    const measure = () => setHeight(chat.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chat);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const chat = anchor.current?.closest<HTMLElement>('[data-testid="copilot-chat"]');
    if (!fits && document.activeElement?.getAttribute("data-testid") === "copilot-scroll-to-bottom" && chat?.contains(document.activeElement)) {
      chat.querySelector<HTMLTextAreaElement>('[data-testid="copilot-chat-textarea"]')?.focus({ preventScroll: true });
    }
    // Chrome clears focus as soon as visibility changes. Transfer it first,
    // then hide the button in the same pre-paint layout update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(fits);
  }, [fits]);
  return (
    <div ref={anchor} data-chat-transcript className="contents">
      {/* Keep the button mounted during resize so focus can move before it
          hides. The SDK otherwise removes it before this layout update. */}
      <ScrollButtonVisibility.Provider value={visible}>
        <CopilotChatView.ScrollView
          {...props}
          className={[props.className, "[&>div:first-child]:scroll-pt-1 [&>div:first-child]:[scroll-padding-bottom:var(--transcript-input-clearance)]"].filter(Boolean).join(" ")}
          style={{
            ...props.style,
            "--transcript-input-clearance": `${(props.inputContainerHeight ?? 0) + 4}px`,
            scrollPaddingTop: 4,
            scrollPaddingBottom: (props.inputContainerHeight ?? 0) + 4,
          } as CSSProperties}
          isResizing={false}
          scrollToBottomButton={ScrollToBottomButton}
        />
      </ScrollButtonVisibility.Provider>
    </div>
  );
}
