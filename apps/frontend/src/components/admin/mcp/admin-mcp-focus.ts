export const MCP_TEXT_FOCUS = "-mx-1 w-fit max-w-full scroll-my-1 rounded-sm px-1 py-0.5 focus:outline-none focus:ring-[3px] focus:ring-ring/50";

export function keepMcpFocusVisible(target: HTMLElement) {
  requestAnimationFrame(() => {
    if (!target.isConnected || document.activeElement !== target) return;
    const rect = target.getBoundingClientRect();
    if (rect.top < 4 || rect.bottom > window.innerHeight - 4) {
      target.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    }
  });
}

export function focusMcpElement(target: HTMLElement | null) {
  if (!target) return;
  target.focus({ preventScroll: true });
  keepMcpFocusVisible(target);
}
