import { useCallback, useEffect, useRef } from "react";

/**
 * Smart auto-scroll hook for chat containers.
 *
 * Behavior:
 * - Auto-scrolls to bottom when new content arrives and the user is near the bottom.
 * - Stops auto-scrolling when the user scrolls up manually.
 * - Re-engages auto-scroll when the user scrolls back near the bottom.
 *
 * User vs programmatic scroll detection:
 * Instead of trying to distinguish scroll event sources (which is fragile with
 * smooth scrolling), we use a simpler approach: on every scroll event, check if
 * we're near the bottom. This means programmatic smooth scrolls that are heading
 * toward the bottom will keep the lock engaged, and user scrolls away from the
 * bottom will disengage it. No flag needed.
 */

const NEAR_BOTTOM_THRESHOLD = 150;

export function useAutoScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  deps: unknown[],
  resetKey?: string | null
) {
  const isLockedToBottom = useRef(true);

  // Reset lock when the conversation changes (e.g. session switch)
  useEffect(() => {
    isLockedToBottom.current = true;
  }, [resetKey]);

  // Track scroll position to detect user intent
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.clientHeight - container.scrollTop;
      isLockedToBottom.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef]);

  // Scroll to bottom when deps change and we're locked
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isLockedToBottom.current) return;

    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    isLockedToBottom.current = true;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [containerRef]);

  return { isLockedToBottom, scrollToBottom };
}
