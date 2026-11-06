// What a modal does for the page behind it: nothing outside the modal takes
// focus, a click or a screen reader's attention. `inert` does all three, in
// every current browser. The helper marks each sibling along the path from the
// kept elements up to the body, so anything that a portal adds later stays
// reachable. Radix Dialog takes the same approach with `aria-hidden`.

const NOT_INTERFACE = new Set(["HEAD", "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);

/** Makes everything outside `keep` inert. Returns the function that undoes it.
 *  It undoes only what it set: an element that was inert before stays inert. */
export function makeBackgroundInert(keep: ReadonlyArray<Element | null | undefined>): () => void {
  const path = new Set<Element>();
  for (const element of keep) {
    for (let node = element ?? null; node; node = node.parentElement) path.add(node);
  }
  const marked: Element[] = [];
  for (const node of path) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (path.has(sibling) || sibling.hasAttribute("inert") || NOT_INTERFACE.has(sibling.tagName)) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
  }
  return () => {
    for (const element of marked) element.removeAttribute("inert");
  };
}

const FOCUSABLE = [
  "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
  "iframe", "audio[controls]", "video[controls]", "[contenteditable]:not([contenteditable=false])", "[tabindex]"
].join(",");

/** The elements inside `container` that Tab reaches, in DOM order. A browser
 *  has no cheap query for this, and jsdom has no layout, so the check reads
 *  attributes: it skips what is disabled, hidden, inert, or in a closed
 *  <details>. Where the browser has `checkVisibility`, it also skips what CSS
 *  does not render, such as a file input with `display: none` behind an
 *  upload button. A positive tabindex is rare and not reordered. */
export function tabbableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.matches(":disabled") || element.tabIndex < 0 || element.closest("[hidden], [inert]")) return false;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) return false;
    const details = element.closest("details");
    return !details || details.open || element.matches("summary") && element.parentElement === details;
  });
}

/** Keeps Tab inside `container`, as a modal does. Call it for a Tab keydown.
 *  It wraps from the last tabbable element to the first and back, and brings
 *  focus that is outside the container back into it. A container with nothing
 *  to tab to takes the focus itself. */
export function keepTabInside(event: { shiftKey: boolean; preventDefault: () => void }, container: HTMLElement): void {
  const items = tabbableWithin(container);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
    return;
  }
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !container.contains(active);
  if (event.shiftKey ? outside || active === first || active === container : outside || active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
