/** Focus that a caller can still move. Body or null focus is always owned. */
export interface FocusOwnership {
  /** Exact elements, without their descendants. */
  origins?: readonly (Element | null | undefined)[];
  /** Includes the region itself and its descendants. */
  scope?: Element | null;
  /** Treat a removed active element as lost focus. */
  disconnectedIsLost?: boolean;
}

export function ownsFocus(ownership: FocusOwnership = {}, active: Element | null = document.activeElement): boolean {
  return active === null || active === document.body ||
    (ownership.disconnectedIsLost === true && !active.isConnected) ||
    ownership.origins?.some(origin => origin === active) === true ||
    ownership.scope?.contains(active) === true;
}

/** Use browser scrolling. Return true only if the target receives focus. */
export function focusIfOwned(target: HTMLElement | null | undefined, ownership?: FocusOwnership): boolean {
  if (!target?.isConnected || !ownsFocus(ownership)) return false;
  target.focus();
  return document.activeElement === target;
}

export interface KeepVisible {
  frames: 1 | 2;
  scroll: ScrollIntoViewOptions;
}

/**
 * After the requested frames, scroll a connected, focused target outside the
 * 4px viewport inset. Return a function that cancels the pending frame.
 */
export function keepFocusVisible(target: HTMLElement, rule: KeepVisible): () => void {
  let remaining = rule.frames;
  let frame: number | null = requestAnimationFrame(check);

  function check() {
    remaining -= 1;
    if (remaining > 0) {
      frame = requestAnimationFrame(check);
      return;
    }
    frame = null;
    if (!target.isConnected || document.activeElement !== target) return;
    const box = target.getBoundingClientRect();
    if (box.top < 4 || box.bottom > window.innerHeight - 4) {
      target.scrollIntoView?.(rule.scroll);
    }
  }

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
