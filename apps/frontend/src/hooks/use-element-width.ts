"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The border-box width of an element, or `null` before the first measurement
 * or where ResizeObserver does not exist. The first measurement runs before
 * paint, so a layout that depends on it does not flash.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    // Measure before paint; the observer then reports later changes.
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(() => setWidth(node.getBoundingClientRect().width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
