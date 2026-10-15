"use client";

import { useEffect } from "react";

export const CONFIRM_LEAVE_MESSAGE = "You have unsaved changes. Leave this page and lose them?";

/**
 * Asks before the page is left while `dirty` is true. It covers reload, tab close,
 * and clicks on links to another page. It does not cover the browser Back button
 * or code that calls the router directly.
 */
export function useConfirmLeave(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when returnValue is set.
      event.returnValue = true;
    };
    // Capture on the document runs before the Next.js Link handler, so a refusal stops the navigation.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const next = new URL(link.href, window.location.href);
      // Another origin unloads the page, so beforeunload asks. The same path keeps this page mounted.
      if (next.origin !== window.location.origin || next.pathname === window.location.pathname) return;
      if (window.confirm(CONFIRM_LEAVE_MESSAGE)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
}
