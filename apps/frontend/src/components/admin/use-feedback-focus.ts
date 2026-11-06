"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/** Focus owned feedback after a write changes its node or sticky layout. */
export function useFeedbackFocus() {
  const queued = useRef<{ origin: Element | null; target: () => HTMLElement | null } | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  useLayoutEffect(() => {
    const request = queued.current;
    queued.current = null;
    if (!request || (document.activeElement !== request.origin && document.activeElement !== document.body)) return;
    const target = request.target();
    if (!target) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    target.focus({ preventScroll: true });
    // Let the browser finish scroll anchoring after the sticky bar changes.
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (document.activeElement !== target || !target.isConnected) return;
        const box = target.getBoundingClientRect();
        if (box.top < 4 || box.bottom > window.innerHeight - 4) {
          target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
        }
      });
    });
  });
  return (target: () => HTMLElement | null) => {
    queued.current = { origin: document.activeElement, target };
  };
}
