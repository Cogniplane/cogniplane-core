// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { keepTabInside, makeBackgroundInert, tabbableWithin } from "./inert-background";

afterEach(() => {
  document.body.innerHTML = "";
});

const inertIds = () => [...document.querySelectorAll("[inert]")].map((element) => element.id || element.tagName);

describe("makeBackgroundInert", () => {
  function page() {
    document.body.innerHTML = `
      <header id="header"><button id="menu">Menu</button></header>
      <main id="main">
        <div id="toolbar"><button id="toggle">Toggle</button></div>
        <div id="row">
          <div id="chat"><textarea id="composer"></textarea></div>
          <button id="backdrop"></button>
          <aside id="panel"><button id="close">Close</button></aside>
        </div>
      </main>
      <script id="script"></script><style id="style"></style>`;
    return { panel: document.getElementById("panel")!, backdrop: document.getElementById("backdrop")! };
  }

  it("marks every sibling along the path to the kept elements, and nothing inside them", () => {
    const { panel, backdrop } = page();
    makeBackgroundInert([panel, backdrop]);
    expect(inertIds().sort()).toEqual(["chat", "header", "toolbar"]);
    expect(document.getElementById("close")!.closest("[inert]")).toBeNull();
  });

  it("undoes only what it set, and leaves an element that was inert before", () => {
    const { panel, backdrop } = page();
    document.getElementById("header")!.setAttribute("inert", "");
    const undo = makeBackgroundInert([panel, backdrop]);
    undo();
    expect(inertIds()).toEqual(["header"]);
  });

  it("leaves an element that a portal adds later reachable", () => {
    const { panel } = page();
    makeBackgroundInert([panel]);
    const portal = document.createElement("div");
    document.body.append(portal);
    expect(portal.closest("[inert]")).toBeNull();
  });

  it("ignores a missing element", () => {
    const { panel } = page();
    expect(() => makeBackgroundInert([panel, null, undefined])).not.toThrow();
  });
});

describe("tabbableWithin", () => {
  it("lists the controls that Tab reaches, in order, and skips the rest", () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="close">Close</button>
        <input id="text" />
        <input id="hiddenInput" type="hidden" />
        <input id="off" disabled />
        <button id="skip" tabindex="-1">Skip</button>
        <div id="hiddenBox" hidden><button id="inHidden">x</button></div>
        <div id="inertBox" inert><button id="inInert">x</button></div>
        <details id="closed"><summary id="sum">More</summary><button id="inClosed">x</button></details>
        <details id="opened" open><summary>Open</summary><button id="inOpen">x</button></details>
        <a id="link" href="/x">Link</a>
        <div id="custom" tabindex="0">Custom</div>
        <textarea id="area"></textarea>
      </div>`;
    const ids = tabbableWithin(document.getElementById("root")!).map((element) => element.id || element.tagName);
    expect(ids).toEqual(["close", "text", "sum", "SUMMARY", "inOpen", "link", "custom", "area"]);
  });
});

describe("keepTabInside", () => {
  function tab(shiftKey = false) {
    let prevented = false;
    keepTabInside({ shiftKey, preventDefault: () => { prevented = true; } }, document.getElementById("box")!);
    return prevented;
  }

  it("wraps at both ends and leaves Tab between controls to the browser", () => {
    document.body.innerHTML = `<button id="out">Out</button><div id="box" tabindex="-1"><button id="a">A</button><button id="b">B</button></div>`;
    document.getElementById("b")!.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    expect(tab(true)).toBe(true);
    expect(document.activeElement?.id).toBe("b");
    document.getElementById("a")!.focus();
    expect(tab()).toBe(false);
  });

  it("brings focus from outside back in, and focuses an empty container", () => {
    document.body.innerHTML = `<button id="out">Out</button><div id="box" tabindex="-1"><button id="a">A</button></div>`;
    document.getElementById("out")!.focus();
    expect(tab(true)).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    document.getElementById("box")!.innerHTML = "<p>Nothing to focus</p>";
    expect(tab()).toBe(true);
    expect(document.activeElement?.id).toBe("box");
  });
});

describe("tabbableWithin where the browser reports rendering", () => {
  it("skips an element that CSS does not render", () => {
    document.body.innerHTML = `<div id="root"><button id="upload">Add source</button><input id="file" type="file" /></div>`;
    const file = document.getElementById("file")!;
    // jsdom has no layout. Stand in for a browser where the input has display: none.
    const visible = (element: Element) => element !== file;
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", { configurable: true, value: function (this: Element) { return visible(this); } });
    try {
      expect(tabbableWithin(document.getElementById("root")!).map((element) => element.id)).toEqual(["upload"]);
    } finally {
      delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
    }
  });
});
