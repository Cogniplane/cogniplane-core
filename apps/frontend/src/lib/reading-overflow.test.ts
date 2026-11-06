// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { watchReadingOverflow } from "./reading-overflow";

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("makes only overflowing SDK code and table containers keyboard readable, including streamed blocks", async () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn(); unobserve = vi.fn(); disconnect = disconnect;
  });
  const root = document.createElement("div");
  root.innerHTML = '<pre data-streamdown="code-block-body"><code>  keep source</code></pre><div><table data-streamdown="table-wrapper"></table></div><div><table data-app-table data-streamdown="table"></table></div>';
  document.body.append(root);
  const pre = root.querySelector("pre")!;
  let width = 100;
  Object.defineProperties(pre, { clientWidth: { get: () => width }, scrollWidth: { get: () => 200 } });
  const stop = watchReadingOverflow(root);
  expect(pre.tabIndex).toBe(0);
  expect(pre.getAttribute("aria-label")).toBe("Code block");
  expect(pre.textContent).toBe("  keep source");
  const tables = root.querySelectorAll("table");
  expect(tables[0]!.parentElement!.hasAttribute("tabindex")).toBe(false);
  expect(tables[1]!.parentElement!.hasAttribute("data-reading-scroll")).toBe(false);
  width = 300; resize();
  expect(pre.hasAttribute("tabindex")).toBe(false);
  const next = document.createElement("pre");
  next.dataset.streamdown = "code-block-body";
  Object.defineProperties(next, { clientWidth: { value: 100 }, scrollWidth: { value: 400 } });
  root.append(next);
  await Promise.resolve();
  expect(next.tabIndex).toBe(0);
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
});
