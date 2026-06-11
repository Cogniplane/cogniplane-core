"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Smoothly animates its own height to fit whatever it wraps. Children that
// appear, disappear, or resize cause the container to grow/shrink with a CSS
// height transition instead of snapping. Inspired by t3code's AnimatedHeight.
//
// Mechanics: an inner element holds the real content; a ResizeObserver tracks
// its measured height and drives the outer element's explicit `height`. We clip
// overflow during the transition so children never spill past the animating
// edge. `prefers-reduced-motion` disables the animation entirely (height jumps).
export function AnimatedHeight({
  children,
  className,
  durationMs = 200
}: {
  children: ReactNode;
  className?: string;
  durationMs?: number;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setHeight(el.scrollHeight);
    });
    observer.observe(el);
    setHeight(el.scrollHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={className}
      style={{
        height: height == null ? "auto" : height,
        overflow: "hidden",
        transition: reducedMotion ? undefined : `height ${durationMs}ms ease`
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
