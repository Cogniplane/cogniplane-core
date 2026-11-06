// The SDK owns these scroll containers. Add reading semantics after it mounts
// or streams new blocks, without replacing its Markdown or copy renderer.
export function watchReadingOverflow(root: HTMLElement): () => void {
  const observed = new Set<HTMLElement>();
  const update = () => {
    const regions = new Map<HTMLElement, string>();
    root.querySelectorAll<HTMLElement>('pre[data-streamdown="code-block-body"]').forEach(pre => regions.set(pre, "Code block"));
    root.querySelectorAll<HTMLTableElement>('table[data-streamdown]').forEach(table => {
      if (!table.hasAttribute("data-app-table") && table.parentElement) regions.set(table.parentElement, "Markdown table");
    });
    for (const [region, label] of regions) {
      if (!observed.has(region)) {
        observed.add(region);
        resize?.observe(region);
      }
      region.dataset.readingScroll = "";
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", label);
      if (region.scrollWidth > region.clientWidth || region.scrollHeight > region.clientHeight) region.tabIndex = 0;
      else region.removeAttribute("tabindex");
    }
    for (const region of observed) if (!root.contains(region)) {
      resize?.unobserve(region);
      observed.delete(region);
    }
  };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  const mutations = new MutationObserver(update);
  mutations.observe(root, { childList: true, characterData: true, subtree: true });
  resize?.observe(root);
  update();
  return () => { mutations.disconnect(); resize?.disconnect(); };
}
