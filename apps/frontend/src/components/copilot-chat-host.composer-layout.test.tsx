// @vitest-environment jsdom

import { A2UI_VERSION } from "@copilotkit/shared";
//
// The height budget of the composer. The SDK pins the composer to the bottom of
// the chat area in an overlay with no height limit. In a short chat area, the
// blocks above the message box (the draft notice, the Review list of entries)
// and a long draft could then grow past the top of the area and hide behind the
// toolbar. On a phone, the on-screen keyboard also covers the bottom of the
// area, and the SDK moves only the message box above it.
//
// jsdom does no layout, so these tests do not prove that anything fits or that
// a click lands. They check the structure that the fix depends on: what scrolls
// and what stays put, that the keyboard leaves its height under the whole
// composer once, and the classes that tie the budgets to the chat area and to
// the keyboard. One test gives the SDK overlay a fake layout, to show that the
// transcript padding follows the keyboard. The sizes in a chat area of about
// 100px, 190px, 320px, 750px and 600px, the keyboard on a real phone, and the
// clicks, need a real browser check.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { FixtureServer, idleHistory, installBrowserLayoutStubs } from "../test-helpers/agui-fixture-server";
import { installKeyboardViewport, type KeyboardViewport } from "../test-helpers/keyboard-viewport";
import { CopilotChatHost } from "./copilot-chat-host";
import { type DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();

const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };

let server: FixtureServer;
let keyboard: KeyboardViewport;
beforeEach(() => {
  server = new FixtureServer();
  vi.stubGlobal("fetch", server.fetch);
  sessionStorage.clear();
  keyboard = installKeyboardViewport();
});
afterEach(() => {
  cleanup();
  keyboard.uninstall();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function hostElement() {
  return (
    <CopilotChatHost
      session={{ id: "s-1", initialToolStatuses: [], initialApprovals: [] }}
      modelSelection={{
        model: "model-1", effort: null, models: [], showEffortSelector: false,
        onModelChange: () => undefined, onEffortChange: () => undefined
      }}
      usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }}
      artifactIds={[]}
      draftScope={USER}
      events={{}}
    />
  );
}

// The composer slot renders one box in the SDK overlay: the scroll region for
// the blocks above the message box, then the message box.
const overlay = () => screen.getByTestId("copilot-input-overlay");
const budgetBox = () => overlay().firstElementChild as HTMLElement;
const scrollRegion = () => budgetBox().firstElementChild as HTMLElement;
/** The box of the SDK message box slot. CopilotChat moves this one by the keyboard height. */
const sdkInputRoot = () => screen.getByTestId("copilot-chat-input").closest("[data-copilotkit]") as HTMLElement;

/** A class that the box has whatever the size of the chat area is. */
const hasClass = (element: Element, name: string) => element.className.split(/\s+/).includes(name);

/** The nearest ancestor inside the overlay that always scrolls. The composer
 *  box scrolls only in a very short chat area, with a conditional class. */
function scrollerOf(element: Element): Element | null {
  for (let node = element.parentElement; node && overlay().contains(node); node = node.parentElement) {
    if (hasClass(node, "overflow-y-auto") || hasClass(node, "overflow-y-scroll")) return node;
  }
  return null;
}

async function showReviewList() {
  const operations = [{ version: A2UI_VERSION, createSurface: {
    surfaceId: "turn:a1:list", dataModel: { priority: "low" },
    components: [{ id: "root", component: "SegmentedControl", label: "Priority",
      options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }], value: { "@path": "/priority" } }]
  } }];
  server.connect("s-1", idleHistory([
    { id: "u0", role: "user", content: "Make a form" },
    { id: "a0", role: "assistant", content: "Here is the form." },
    { id: "genui:turn:a1:list", role: "activity", activityType: "generative-ui-surface",
      content: { surfaceId: "turn:a1:list", target: "chat", catalogId: "cogniplane/standard@1", operations, status: "ready", rejected: [] } }
  ]));
  render(hostElement());
  await screen.findByRole("radio", { name: "Low" });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  fireEvent.click(screen.getByRole("radio", { name: "High" }));
  const summary = (await screen.findByText(/go with your next message/)).closest("summary")!;
  fireEvent.click(summary);
  return summary;
}

/** A Checklist that the user edited and put in the message box. The composer
 *  then shows the Review summary and the draft notice together. */
async function showReviewAndDraft() {
  const operations = [{ version: A2UI_VERSION, createSurface: {
    surfaceId: "turn:a1:list", dataModel: { release: { checked: { tests: true }, notes: "" } },
    components: [{ id: "root", component: "Checklist", title: "Release 4.2",
      items: [{ id: "tests", label: "Tests pass" }, { id: "docs", label: "Release notes published" }],
      checked: { "@path": "/release/checked" }, notes: { "@path": "/release/notes" } }]
  } }];
  server.connect("s-1", idleHistory([
    { id: "u0", role: "user", content: "Make a checklist" },
    { id: "a0", role: "assistant", content: "Here is the checklist." },
    { id: "genui:turn:a1:list", role: "activity", activityType: "generative-ui-surface",
      content: { surfaceId: "turn:a1:list", target: "chat", catalogId: "cogniplane/standard@1", operations, status: "ready", rejected: [] } }
  ]));
  render(hostElement());
  fireEvent.click(await screen.findByRole("checkbox", { name: "Release notes published" }));
  await screen.findByText(/go with your next message/);
  fireEvent.click(screen.getByRole("button", { name: "Use in reply" }));
  return screen.getByRole("group", { name: "Draft from a generated view" });
}

describe("the height budget of the composer", () => {
  it("scrolls the draft notice and keeps the message box and Send outside the scroll region", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    fireEvent.click(await screen.findByRole("button", { name: "Build a checklist" }));

    const notice = screen.getByRole("group", { name: "Starter draft" });
    const region = scrollRegion();
    expect(region.contains(notice)).toBe(true);
    expect(region.contains(screen.getByRole("button", { name: "Clear draft" }))).toBe(true);
    expect(scrollerOf(notice)).toBe(region);
    // The box and its buttons keep their size, whatever the notice holds.
    const textarea = screen.getByTestId("copilot-chat-textarea");
    const send = screen.getByTestId("copilot-send-button");
    expect(budgetBox().contains(textarea)).toBe(true);
    expect(budgetBox().contains(send)).toBe(true);
    expect(region.contains(textarea)).toBe(false);
    expect(region.contains(send)).toBe(false);
    expect(scrollerOf(textarea)).toBe(budgetBox());
    expect(scrollerOf(send)).toBe(budgetBox());
  });

  it("scrolls the Review list in the same region, with no second scroll area inside it", async () => {
    const summary = await showReviewList();

    const region = scrollRegion();
    const details = summary.closest("details")!;
    expect(details.open).toBe(true);
    expect(region.contains(details)).toBe(true);
    expect(scrollerOf(summary)).toBe(region);
    // A scroll area inside the list would trap the wheel and the touch drag.
    expect(scrollerOf(details.querySelector("dl")!)).toBe(region);
    expect(budgetBox().contains(screen.getByTestId("copilot-chat-textarea"))).toBe(true);
    expect(region.contains(screen.getByTestId("copilot-chat-textarea"))).toBe(false);
  });

  it("leaves the scroll region with no child when no block shows, so it takes no space", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");

    // `empty:hidden` matches only an element with no child node at all.
    expect(scrollRegion().childNodes).toHaveLength(0);
  });

  it("ties the budgets of the composer and of the message box to the chat area, not to the window", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    const textarea = await screen.findByTestId("copilot-chat-textarea");

    // `cqh` is a share of the nearest ancestor with size containment. Without
    // that ancestor it falls back to the window height.
    expect(budgetBox().className).toMatch(/\[--composer-budget:[^\]]*cqh[^\]]*\]/);
    expect(budgetBox().className).toContain("max-h-(--composer-budget)");
    // The SDK sets an inline `max-height` on the box, so the class needs `!`.
    expect(textarea.className).toMatch(/\bmax-h-\[[^\]]*cqh[^\]]*\]!/);
    expect(textarea.className).toContain("var(--composer-budget)");
    const sized = screen.getByTestId("copilot-chat").closest('[class*="container-type:size"]');
    expect(sized).not.toBeNull();
    expect(sized!.contains(overlay())).toBe(true);
  });

  it("makes the whole composer scroll, and not only the blocks, in a chat area shorter than the floor of the region and the message box", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");

    // The composer box takes the scroll in a short area, so the region and the
    // message box both stay in reach, including when transcript focus reduces
    // the budget in an otherwise tall frame.
    expect(hasClass(budgetBox(), "overflow-y-auto")).toBe(true);
    // A `justify-end` box would put the overflow above the area, where nobody
    // can scroll to it.
    expect(budgetBox().className).not.toMatch(/\bjustify-end\b/);
  });

  it("keeps the region at a floor of its own content, so a short area cannot shrink it to nothing", async () => {
    // The floor comes from the height of the blocks. jsdom has no layout, so
    // each block is 40px tall.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
    await showReviewAndDraft();
    const region = scrollRegion();
    const content = () => region.style.getPropertyValue("--composer-region-content");

    // The region is never lower than the smaller of its content and 8rem. A
    // fixed minimum would leave a gap under a single short block.
    expect(region.className).toContain("min-h-[min(var(--composer-region-content,0px),8rem,max(0px,calc(var(--composer-budget)_-_9.25rem)))]");
    await waitFor(() => expect(content()).toBe("80px"));

    // The floor follows the content down: a floor from older content would
    // hold the region open on its own.
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    await waitFor(() => expect(content()).toBe("40px"));
  });
});

describe("the first rows of the composer", () => {
  it("puts Clear draft in the first row of the notice, next to its name and before its text", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    fireEvent.click(await screen.findByRole("button", { name: "Build a checklist" }));

    const notice = screen.getByRole("group", { name: "Starter draft" });
    const row = notice.firstElementChild as HTMLElement;
    expect(row.textContent).toContain("Starter draft: Build a checklist");
    expect(within(row).getByRole("button", { name: "Clear draft" })).toBeTruthy();
    // The text of the notice follows the row, and the notice has no other button.
    const text = screen.getByText(/Nothing is sent until you press Send/);
    expect(row.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(notice).getAllByRole("button")).toHaveLength(1);
  });

  it("shows the draft decision before expanded generated values", async () => {
    const notice = await showReviewAndDraft();

    const region = scrollRegion();
    const summary = region.querySelector("summary")!;
    expect(region.contains(summary)).toBe(true);
    expect(region.contains(notice)).toBe(true);
    expect(notice.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Both controls are in the first row of their block.
    expect(within(notice.firstElementChild as HTMLElement).getByRole("button", { name: "Clear draft" })).toBeTruthy();
    expect(within(summary).getByText("Review")).toBeTruthy();
  });

  it("keeps the sentence of the summary apart from the Review label, so a narrow chat can cut the sentence only", async () => {
    const summary = await showReviewList();

    const sentence = within(summary).getByText(/go with your next message/);
    const label = within(summary).getByText("Review");
    expect(sentence.contains(label)).toBe(false);
    expect(sentence.textContent).toBe("Your entries in 1 generated view go with your next message.");
    // The narrow rules are container queries on the width of the chat. They
    // cut the sentence, and they never hide the label.
    expect(sentence.className).toContain("@max-md:truncate");
    expect(label.className).not.toMatch(/\bhidden\b|truncate/);
  });
});

describe("the on-screen keyboard", () => {
  it("does not treat pinch zoom as a keyboard", async () => {
    await showReviewAndDraft();
    keyboard.open(300, { scale: 1.5 });
    expect(budgetBox().style.marginBottom).toBe("");
    expect(sdkInputRoot().style.transform).toBe("");
    expect((screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement).value).toContain("Checklist: Release 4.2");
  });

  it("reserves only the chat covered after the visible viewport shifts", async () => {
    await showReviewAndDraft();
    keyboard.open(300, { offsetTop: 100 });
    expect(budgetBox().style.marginBottom).toBe("200px");
    keyboard.open(300, { offsetTop: 100, chatBottom: window.innerHeight - 60 });
    expect(budgetBox().style.marginBottom).toBe("140px");
    keyboard.open(300, { offsetTop: 300 });
    expect(budgetBox().style.marginBottom).toBe("");
  });

  it("leaves the keyboard height under the whole composer and sets the offset for the budgets", async () => {
    await showReviewAndDraft();
    expect(budgetBox().getAttribute("style")).toBeNull();

    keyboard.open(300);

    // A margin is in the layout of the overlay. A transform is not, and the
    // overlay would keep its height, so the transcript would not make room.
    expect(budgetBox().parentElement).toBe(overlay());
    expect(budgetBox().style.marginBottom).toBe("300px");
    expect(budgetBox().style.transform).toBe("");
    expect(budgetBox().style.getPropertyValue("--composer-keyboard-offset")).toBe("300px");
    // The blocks and the message box are inside the box, so they move together.
    expect(budgetBox().contains(scrollRegion())).toBe(true);
    expect(budgetBox().contains(screen.getByRole("button", { name: "Clear draft" }))).toBe(true);
    expect(budgetBox().contains(screen.getByTestId("copilot-chat-textarea"))).toBe(true);
    expect(budgetBox().contains(screen.getByTestId("copilot-send-button"))).toBe(true);
  });

  it("does not let the SDK move the message box a second time", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");
    // The SDK moves its message box when it gets a keyboard height. This
    // box is the one that it would move, so it must not move.
    expect(sdkInputRoot().style.transform).toBe("");

    keyboard.open(300);

    expect(sdkInputRoot().style.transform).toBe("");
    expect(budgetBox().contains(sdkInputRoot())).toBe(true);
  });

  it("subtracts the keyboard from both budgets, and makes the composer scroll if it is too tall for the rest", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    const textarea = await screen.findByTestId("copilot-chat-textarea");

    keyboard.open(300);

    // The classes read the offset that the box sets, and the box and the
    // message box sit under the same property.
    expect(budgetBox().className).toContain("--composer-keyboard-offset");
    expect(textarea.className).toContain("--composer-keyboard-offset");
    expect(budgetBox().contains(textarea)).toBe(true);
    // The area that the keyboard leaves can be shorter than the composer, so
    // the box scrolls then, with no condition on the size of the chat.
    expect(hasClass(budgetBox(), "overflow-y-auto")).toBe(true);
    expect(scrollerOf(textarea)).toBe(budgetBox());
  });

  it("changes nothing without the keyboard, and goes back when the keyboard closes", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");
    const before = budgetBox().className;

    // A visual viewport that is not smaller than the window gives no keyboard.
    keyboard.open(0);
    expect(budgetBox().getAttribute("style")).toBeNull();
    expect(budgetBox().className).toBe(before);

    // The SDK ignores a small change, such as the address bar of a browser.
    keyboard.open(100);
    expect(budgetBox().getAttribute("style")).toBeNull();
    expect(budgetBox().className).toBe(before);

    keyboard.open(300);
    expect(budgetBox().style.marginBottom).toBe("300px");

    keyboard.close();
    // React clears the properties and leaves an empty `style` attribute.
    expect(budgetBox().style.marginBottom).toBe("");
    expect(budgetBox().style.getPropertyValue("--composer-keyboard-offset")).toBe("");
    expect(budgetBox().className).toBe(before);
  });

  describe("with a fake layout for the overlay", () => {
    // CopilotChat reads the height of its overlay with a ResizeObserver and adds
    // it to the padding at the end of the transcript. jsdom has no layout, so
    // this observer says that each child of the overlay is 100px tall, plus the
    // bottom margin that the child sets.
    const observers: Array<{ target: Element; callback: ResizeObserverCallback }> = [];
    const overlayHeight = (element: Element) =>
      [...element.children].reduce((sum, child) => sum + 100 + (parseFloat((child as HTMLElement).style.marginBottom) || 0), 0);
    const reflow = () => act(() => {
      for (const { target, callback } of observers) {
        if (target.getAttribute("data-testid") !== "copilot-input-overlay") continue;
        callback([{ target, contentRect: { height: overlayHeight(target) } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
    });
    const transcriptPadding = () => Number.parseFloat(screen.getByTestId("copilot-scroll-content").style.paddingBottom);

    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal("ResizeObserver", class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) { observers.push({ target, callback: this.callback }); }
        unobserve() {}
        disconnect() {}
      });
    });

    it("adds the keyboard height to the space at the end of the transcript, so the last messages stay above the composer", async () => {
      server.connect("s-1", idleHistory([{ id: "u0", role: "user", content: "Hello" }, { id: "a0", role: "assistant", content: "Hi" }]));
      render(hostElement());
      await screen.findByTestId("copilot-chat-textarea");
      reflow();
      const closed = transcriptPadding();
      // The padding holds the overlay, and the overlay holds the composer.
      expect(closed).toBeGreaterThanOrEqual(100);

      keyboard.open(300);
      reflow();
      expect(transcriptPadding() - closed).toBe(300);

      keyboard.close();
      reflow();
      expect(transcriptPadding()).toBe(closed);
    });
  });
});

describe("the cue that the region holds more", () => {
  /** jsdom has no layout, so the test gives the region a size that it can scroll. */
  function sizeRegion(region: HTMLElement, state: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    for (const key of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
      Object.defineProperty(region, key, { configurable: true, get: () => state[key] });
    }
  }
  const cue = () => screen.queryByTestId("composer-scroll-cue");

  it("shows while content waits below the part in view, and goes at the end", async () => {
    await showReviewAndDraft();
    expect(cue()).toBeNull();

    const state = { scrollHeight: 228, clientHeight: 77, scrollTop: 0 };
    sizeRegion(scrollRegion(), state);
    // A scroll event measures the region. In a browser, the resize of the
    // region and a change of its blocks do the same.
    act(() => { scrollRegion().dispatchEvent(new Event("scroll")); });
    expect(cue()).not.toBeNull();
    // The cue is not a control: no pointer, no reader.
    expect(cue()!.getAttribute("aria-hidden")).toBe("true");
    expect(cue()!.className).toContain("pointer-events-none");
    // The cue occupies its own row, so it cannot cover a line or control.
    expect(scrollRegion().contains(cue())).toBe(false);

    state.scrollTop = 151;
    act(() => { scrollRegion().dispatchEvent(new Event("scroll")); });
    expect(cue()).toBeNull();
  });

  it("does not show when everything fits", async () => {
    await showReviewAndDraft();
    sizeRegion(scrollRegion(), { scrollHeight: 77, clientHeight: 77, scrollTop: 0 });

    act(() => { scrollRegion().dispatchEvent(new Event("scroll")); });

    expect(cue()).toBeNull();
  });

  it("measures again when the Review list opens, because a details element does not bubble its toggle", async () => {
    await showReviewAndDraft();
    const state = { scrollHeight: 77, clientHeight: 77, scrollTop: 0 };
    sizeRegion(scrollRegion(), state);
    act(() => { scrollRegion().dispatchEvent(new Event("scroll")); });
    expect(cue()).toBeNull();

    state.scrollHeight = 305;
    act(() => { scrollRegion().querySelector("details")!.dispatchEvent(new Event("toggle")); });

    expect(cue()).not.toBeNull();
  });
});
