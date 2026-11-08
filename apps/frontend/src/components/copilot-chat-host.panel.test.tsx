// @vitest-environment jsdom

import { A2UI_VERSION } from "@copilotkit/shared";
//
// The side panel and the values that a user types into generated UI, in the
// chat host with the real CopilotKit provider, surface manager and CopilotChat,
// the real DeepAgentsBrowserAgent, and a fixture for the network. Three
// groups: what tells the user about a new view, the focus rules of the
// panel on a narrow host row, and the drafts that survive a reload. The
// panel measures its host row, so the tests set that width and keep a wide
// viewport.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { CopilotChatHost } from "./copilot-chat-host";
import { clearGenerativeUiDrafts, DRAFT_STORAGE_KEY, type DraftScope } from "./generative-ui-drafts.logic";
import { otherOverlayOpen, SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";

installBrowserLayoutStubs();

const PANEL = GENERATIVE_UI_PANEL_TARGET;
const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };
const OTHER_USER: DraftScope = { userId: "user-2", tenantId: "tenant-1" };

let server: FixtureServer;
beforeEach(() => {
  server = new FixtureServer();
  vi.stubGlobal("fetch", server.fetch);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
});

function hostElement(options: { id?: string; scope?: DraftScope | null } = {}) {
  const sessionId = options.id ?? "s-1";
  return (
    <CopilotChatHost
      key={sessionId}
      session={{ id: sessionId, initialToolStatuses: [], initialApprovals: [] }}
      modelSelection={{
        model: "model-1", effort: null, models: [], showEffortSelector: false,
        onModelChange: () => undefined, onEffortChange: () => undefined
      }}
      usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }}
      artifactIds={[]}
      draftScope={options.scope === null ? undefined : options.scope ?? USER}
      events={{}}
    />
  );
}

const EARLIER = [
  { id: "u0", role: "user", content: "Earlier question" },
  { id: "a0", role: "assistant", content: "Earlier answer" }
];
const createSurface = (surfaceId: string, components: object[], dataModel: object = {}) =>
  ({ version: A2UI_VERSION, createSurface: { surfaceId, dataModel, components } });
const deleteSurface = (surfaceId: string) => ({ version: A2UI_VERSION, deleteSurface: { surfaceId } });
const surfaceContent = (target: string, surfaceId: string, operations: object[], status = "ready") =>
  ({ surfaceId, target, catalogId: "cogniplane/standard@1", operations, status, rejected: [] });
const activity = (target: string, surfaceId: string, operations: object[]) =>
  ({ id: `genui:${surfaceId}`, role: "activity", activityType: "generative-ui-surface", content: surfaceContent(target, surfaceId, operations) });
const snapshotEvent = (target: string, surfaceId: string, operations: object[], status = "ready") =>
  ({ type: "ACTIVITY_SNAPSHOT", messageId: `genui:${surfaceId}`, activityType: "generative-ui-surface", content: surfaceContent(target, surfaceId, operations, status) });
const textView = (surfaceId: string, text: string) => [createSurface(surfaceId, [{ id: "root", component: "Text", text }])];

const FORM = "turn:a1:form";
const INLINE = "turn:a1:inline";
const formOps = (title = "Release form") => [createSurface(FORM, [
  { id: "root", component: "Column", children: ["title", "notes", "ready", "tests"] },
  { id: "title", component: "Text", text: title },
  { id: "notes", component: "TextArea", label: "Notes", value: { "@path": "/notes" } },
  { id: "ready", component: "CheckBox", label: "Rollback ready", value: { "@path": "/ready" } },
  { id: "tests", component: "CheckBox", label: "Tests pass", value: { "@path": "/tests" } }
], { notes: "Default note", ready: true, tests: false })];
const inlineOps = () => [createSurface(INLINE, [
  { id: "root", component: "TextField", label: "Chat name", value: { "@path": "/name" } }
], { name: "Ada" })];
const SAVED = [
  ...EARLIER,
  { id: "a1", role: "assistant", content: "Here is the form." },
  activity(PANEL, FORM, formOps()),
  activity("chat", INLINE, inlineOps())
];

const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
const toggle = () => screen.getByRole("button", { name: /^Side panel/ });
const panel = () => document.querySelector("aside[id^='side-panel-']") as HTMLElement;
/** Inert elements other than the panel, which is inert while it is closed. */
const inertBackground = () => [...document.querySelectorAll("[inert]")].filter((element) => element !== panel());
const liveRegion = () => document.querySelector("[aria-live='polite']") as HTMLElement;
const field = <T extends HTMLElement>(label: string) => screen.getByLabelText(label) as T;
const stored = () => JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
const flushDrafts = () => act(async () => { window.dispatchEvent(new Event("pagehide")); });
// Wide enough for the panel beside a readable chat, and too narrow for it.
const WIDE_HOST = 1000;
const NARROW_HOST = 600;
let hostWidth = WIDE_HOST;
const rowObservers = new Map<ResizeObserverCallback, Element>();

/** Sets the width of the host row (the parent of the panel). The viewport
 *  stays wide, so only the row can make the panel a modal. */
function stubHostWidth(width: number) {
  hostWidth = width;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { if (isHostRow(target)) rowObservers.set(this.callback, target); }
    unobserve() {}
    disconnect() { rowObservers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rowWidth = isHostRow(this) ? hostWidth : 0;
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: rowWidth, width: rowWidth, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

const isHostRow = (element: Element) => element.querySelector(":scope > aside[id^='side-panel-']") !== null;

/** The host row changes width, for example when a shell panel opens. */
function resizeHost(width: number) {
  hostWidth = width;
  act(() => {
    for (const [callback, target] of rowObservers) {
      callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

/** Sends a message and returns the stream of its reply. */
async function startTurn(): Promise<FixtureStream> {
  let reply!: FixtureStream;
  server.messageReplies = [(stream) => { reply = stream; }];
  fireEvent.change(composer(), { target: { value: "Show a view" } });
  await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
  await waitFor(() => expect(reply).toBeDefined());
  return reply;
}

describe("how the panel tells the user about a view", () => {
  it("opens for no view that the history load brings, and says nothing", async () => {
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByText("Earlier answer");
    await waitFor(() => expect(within(panel()).queryByText("Release form")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("(has a view)");
    expect(toggle().textContent).not.toContain("New");
    expect(screen.queryByRole("button", { name: "View side panel" })).toBeNull();
    expect(liveRegion().textContent).toBe("");
  });

  it("does not open for a view that a later connection brings in its history", async () => {
    server.running.set("s-1", true);
    const opening = [...EARLIER, { id: "u1", role: "user", content: "Second question" }];
    const attached = (messages: object[]) => (stream: FixtureStream) => stream.push(
      ...ev.history({ messages, activeTurn: "attached" }), ev.runStarted("a1"), ev.turnStarted("a1"),
      ev.userPersisted("u1", "Second question"), ev.textStart("live-1"), ev.text("live-1", "Working")
    );
    server.connect("s-1", attached(opening), attached([...opening, activity(PANEL, FORM, formOps())]));
    render(hostElement());
    await screen.findByText("Working");
    expect(within(panel()).queryByText("Release form")).toBeNull();

    // The stream drops. The next connection's history holds a view that the
    // first one did not. A history is not a live update.
    await act(async () => { server.streamsOf("connect:s-1")[0]!.fail(); });
    await waitFor(() => expect(within(panel()).queryByText("Release form")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "View side panel" })).toBeNull();
    expect(liveRegion().textContent).toBe("");
  });

  it("opens a new live view on a wide screen without moving the focus, and announces it", async () => {
    stubHostWidth(WIDE_HOST);
    server.connect("s-1", idleHistory(EARLIER));
    render(hostElement());
    await screen.findByText("Earlier answer");
    const reply = await startTurn();
    composer().focus();
    await act(async () => { reply.push(ev.runStarted("a2"), snapshotEvent(PANEL, "turn:a2:board", textView("turn:a2:board", "Live board"), "streaming")); });
    await waitFor(() => expect(within(panel()).queryByText("Live board")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(composer());
    expect(liveRegion().textContent).toBe("The agent opened a view in the side panel.");
    expect(screen.queryByRole("button", { name: "View side panel" })).toBeNull();
    // A second view of the same panel does not announce again, and the panel stays open.
    await act(async () => { reply.push(snapshotEvent(PANEL, "turn:a2:next", textView("turn:a2:next", "Second board")), ev.runFinished("a2")); reply.finish(); });
    await waitFor(() => expect(within(panel()).queryByText("Second board")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the panel closed after the user closed it, and offers a View side panel button", async () => {
    stubHostWidth(WIDE_HOST);
    server.connect("s-1", idleHistory(EARLIER));
    render(hostElement());
    await screen.findByText("Earlier answer");
    // The user opens the panel and closes it again before any view exists.
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    const reply = await startTurn();
    await act(async () => { reply.push(ev.runStarted("a2"), snapshotEvent(PANEL, "turn:a2:board", textView("turn:a2:board", "Live board")), ev.runFinished("a2")); reply.finish(); });
    await waitFor(() => expect(within(panel()).queryByText("Live board")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("New");
    expect(toggle().textContent).toContain("(new view)");
    expect(liveRegion().textContent).toBe("The agent added a view to the side panel.");
    const notice = screen.getByRole("button", { name: "View side panel" });
    expect(notice.getAttribute("aria-controls")).toBe(panel().id);

    composer().focus();
    fireEvent.click(notice);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(within(panel()).getByRole("button", { name: "Close side panel" }));
    expect(screen.queryByRole("button", { name: "View side panel" })).toBeNull();
    expect(toggle().textContent).not.toContain("New");
    expect(liveRegion().textContent).toBe("");
  });

  it("does not cover the chat on a narrow host row: the view waits for the user's action", async () => {
    stubHostWidth(NARROW_HOST);
    server.connect("s-1", idleHistory(EARLIER));
    render(hostElement());
    await screen.findByText("Earlier answer");
    const reply = await startTurn();
    await act(async () => { reply.push(ev.runStarted("a2"), snapshotEvent(PANEL, "turn:a2:board", textView("turn:a2:board", "Live board")), ev.runFinished("a2")); reply.finish(); });
    await waitFor(() => expect(within(panel()).queryByText("Live board")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "View side panel" })).toBeTruthy();
    expect(liveRegion().textContent).toBe("The agent added a view to the side panel.");

    fireEvent.click(screen.getByRole("button", { name: "View side panel" }));
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeTruthy();
  });

  it("animates open and close, and turns the motion off for prefers-reduced-motion", async () => {
    stubHostWidth(WIDE_HOST);
    server.connect("s-1", idleHistory(EARLIER));
    render(hostElement());
    await screen.findByText("Earlier answer");
    const classes = () => panel().className.split(" ");
    // Closed, the panel stays laid out at zero width, so the close can animate.
    expect(classes()).toEqual(expect.arrayContaining(["w-0", "invisible", "transition-[width,border-width,visibility]", "motion-reduce:transition-none"]));
    expect(classes()).not.toContain("hidden");
    fireEvent.click(toggle());
    expect(classes()).toEqual(expect.arrayContaining(["w-[min(45%,420px)]", "visible", "motion-reduce:transition-none"]));
  });
});

describe("the panel on a narrow host row is a modal", () => {
  /** An attached turn, so the host shows Stop and Esc means Stop outside the panel. */
  async function openedPanel(extra: object[] = [], shown = "Release form") {
    stubHostWidth(NARROW_HOST);
    server.connect("s-1", (stream) => stream.push(
      ...ev.history({ messages: [...EARLIER, { id: "u1", role: "user", content: "Second question" },
        activity(PANEL, FORM, formOps()), ...extra], activeTurn: "attached" }),
      ev.runStarted("a1"), ev.turnStarted("a1"), ev.userPersisted("u1", "Second question"),
      ev.textStart("live-1"), ev.text("live-1", "Working")
    ));
    server.interruptReply = { status: 200, body: {} };
    render(hostElement());
    await screen.findByText("Working");
    // The closed panel is inert and invisible, so a role query has to include hidden elements.
    await waitFor(() => expect(within(panel()).queryByText(shown) ?? within(panel()).queryByRole("button", { name: shown, hidden: true })).toBeTruthy());
    fireEvent.click(toggle());
    return screen.getByRole("dialog", { name: "Side panel" });
  }

  it("is a dialog, and nothing behind it takes focus or a click until it closes", async () => {
    const dialog = await openedPanel();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(otherOverlayOpen()).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close side panel" }));
    // The toolbar, the message box and the app around the host are inert.
    expect(toggle().closest("[inert]")).not.toBeNull();
    expect(composer().closest("[inert]")).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();
    expect(document.querySelector("button[aria-hidden='true'][tabindex='-1']")!.closest("[inert]")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close side panel" }));
    expect(inertBackground()).toHaveLength(0);
    expect(document.activeElement).toBe(toggle());
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(otherOverlayOpen()).toBe(false);
    // The mounted values stay while it is closed.
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Default note");
  });

  it("keeps Tab inside the panel in both directions", async () => {
    const dialog = await openedPanel();
    const close = within(dialog).getByRole("button", { name: "Close side panel" });
    const last = field<HTMLInputElement>("Tests pass");
    // Shift+Tab on the first control goes to the last one.
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    // Tab on the last control goes to the first one.
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    // Tab inside the panel is left to the browser.
    expect(fireEvent.keyDown(field("Notes"), { key: "Tab" })).toBe(true);
  });

  it("blocks unrelated global shortcuts while modal and enables them again after Close", async () => {
    const onShortcut = vi.fn();
    function ShortcutProbe() {
      useShortcut(SHORTCUTS.toggleArtifacts, onShortcut);
      useShortcut(SHORTCUTS.toggleSidebar, onShortcut);
      return null;
    }
    const dialog = await openedPanel();
    render(<ShortcutProbe />);
    const close = within(dialog).getByRole("button", { name: "Close side panel" });
    fireEvent.keyDown(close, { key: ".", ctrlKey: true });
    fireEvent.keyDown(close, { key: "S", ctrlKey: true, shiftKey: true });
    expect(onShortcut).not.toHaveBeenCalled();
    fireEvent.click(close);
    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    expect(onShortcut).toHaveBeenCalledOnce();
  });

  it("closes on Escape without stopping the agent, and gives the focus back to the toggle", async () => {
    const dialog = await openedPanel();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.keyDown(field("Notes"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle());
    expect(server.count("POST /sessions/s-1/interrupt")).toBe(0);
    // Outside the panel, Escape is still Stop.
    fireEvent.keyDown(composer(), { key: "Escape" });
    await waitFor(() => expect(server.count("POST /sessions/s-1/interrupt")).toBe(1));
  });

  it("leaves Escape to a Modal of the view first, then closes the panel", async () => {
    const MODAL = "turn:a1:modal";
    const dialog = await openedPanel([activity(PANEL, MODAL, [createSurface(MODAL, [
      { id: "root", component: "Modal", title: "Details", trigger: "open", content: "body" },
      { id: "open", component: "Button", label: "Open details" },
      { id: "body", component: "Text", text: "Details body" }
    ])])], "Open details");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open details" }));
    const inner = await screen.findByText("Details body");
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    fireEvent.keyDown(inner, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Details body")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeTruthy();
    expect(server.count("POST /sessions/s-1/interrupt")).toBe(0);

    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close side panel" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
  });

  it("closes on a tap outside, and a wide host row stays nonmodal", async () => {
    const dialog = await openedPanel();
    fireEvent.click(document.querySelector("button[aria-hidden='true'][tabindex='-1']")!);
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle());
    cleanup();

    stubHostWidth(WIDE_HOST);
    server.connect("s-1", idleHistory([...EARLIER, activity(PANEL, FORM, formOps())]));
    render(hostElement());
    await screen.findByText("Earlier answer");
    fireEvent.click(toggle());
    const region = screen.getByRole("complementary", { name: "Side panel" });
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(fireEvent.keyDown(field("Tests pass"), { key: "Tab" })).toBe(true);
    // Escape in a nonmodal panel is not the panel's.
    expect(fireEvent.keyDown(field("Notes"), { key: "Escape" })).toBe(true);
    expect(region.hasAttribute("inert")).toBe(false);
  });

  it("closes instead of covering the chat when its host row gets narrow, and opens as a modal on request", async () => {
    stubHostWidth(WIDE_HOST);
    server.connect("s-1", idleHistory([...EARLIER, activity(PANEL, FORM, formOps())]));
    render(hostElement());
    await screen.findByText("Earlier answer");
    fireEvent.click(toggle());
    expect(screen.getByRole("complementary", { name: "Side panel" })).toBeTruthy();
    composer().focus();

    // A shell panel opens and leaves the host too little room for both.
    resizeHost(NARROW_HOST);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(inertBackground()).toHaveLength(0);
    expect(document.activeElement).toBe(composer());
    // The values stay mounted.
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Default note");

    fireEvent.click(toggle());
    const dialog = screen.getByRole("dialog", { name: "Side panel" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(composer().closest("[inert]")).not.toBeNull();

    // Room comes back: the open panel goes beside the chat again, nonmodal.
    resizeHost(WIDE_HOST);
    expect(screen.getByRole("complementary", { name: "Side panel" }).getAttribute("aria-modal")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("keeps Tab and Escape inside an image lightbox that opens from the modal panel", async () => {
    const IMAGE = "turn:a1:image";
    const dialog = await openedPanel([activity(PANEL, IMAGE, [createSurface(IMAGE, [
      { id: "root", component: "Column", children: ["chart"] },
      { id: "chart", component: "Image", url: "/downloads/chart.png", description: "Quarterly chart" }
    ])])], "Enlarge image: Quarterly chart");
    const trigger = within(dialog).getByRole("button", { name: "Enlarge image: Quarterly chart" });
    fireEvent.click(trigger);
    const lightbox = await screen.findByRole("dialog", { name: "Quarterly chart" });
    await waitFor(() => expect(lightbox.contains(document.activeElement)).toBe(true));

    // Tab wraps inside the lightbox. The panel under it does not take the key.
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(lightbox.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(lightbox.contains(document.activeElement)).toBe(true);

    // Escape closes only the lightbox: the panel stays open and the agent runs on.
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quarterly chart" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    expect(server.count("POST /sessions/s-1/interrupt")).toBe(0);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(server.count("POST /sessions/s-1/interrupt")).toBe(0);
  });
});

describe("drafts of generated UI", () => {
  const LONG = `${"Rollback checklist line. ".repeat(60)}TAIL-5938`;

  it("bring the typed values back after a reload, in the panel and in the chat, including false and empty text", async () => {
    server.connect("s-1", idleHistory(SAVED));
    const first = render(hostElement());
    await screen.findByText("Earlier answer");
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: LONG } });
    fireEvent.click(field("Rollback ready"));
    fireEvent.click(field("Tests pass"));
    fireEvent.change(field("Chat name"), { target: { value: "" } });
    await flushDrafts();
    first.unmount();
    const record = stored();
    expect(record.sessions["s-1"].surfaces[FORM].values).toEqual({ "/notes": LONG, "/ready": false, "/tests": true });
    expect(record.sessions["s-1"].surfaces[INLINE].values).toEqual({ "/name": "" });

    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByText("Earlier answer");
    await waitFor(() => expect(field<HTMLTextAreaElement>("Notes").value).toBe(LONG));
    expect(field<HTMLInputElement>("Rollback ready").checked).toBe(false);
    expect(field<HTMLInputElement>("Tests pass").checked).toBe(true);
    expect(field<HTMLInputElement>("Chat name").value).toBe("");

    // The model reads the restored values, as it reads typed ones.
    server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.runFinished("a9")); stream.finish(); }];
    fireEvent.change(composer(), { target: { value: "Check the form" } });
    await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(String(server.sent[0]!.generativeUiContext)).toContain("TAIL-5938");
  });

  it("write only values that the user edited", async () => {
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByLabelText("Notes");
    await flushDrafts();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    fireEvent.click(field("Tests pass"));
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[FORM].values).toEqual({ "/tests": true });
  });

  it("keep a draft that is waiting for its history through an early flush, then restore it", async () => {
    server.connect("s-1", idleHistory(SAVED));
    const first = render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Typed before the reload" } });
    await flushDrafts();
    first.unmount();

    // The new tab's connection has not answered yet. The manager is empty.
    let held!: FixtureStream;
    server.connect("s-1", (stream) => { held = stream; });
    render(hostElement());
    await waitFor(() => expect(held).toBeDefined());
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[FORM].values["/notes"]).toBe("Typed before the reload");

    await act(async () => { held.push(...ev.history({ messages: SAVED })); held.finish(); });
    await waitFor(() => expect(field<HTMLTextAreaElement>("Notes").value).toBe("Typed before the reload"));
  });

  it("are for one person and one session", async () => {
    server.connect("s-1", idleHistory(SAVED));
    const first = render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Private words" } });
    await flushDrafts();
    first.unmount();

    // Another session of the same person, with a surface of the same id.
    server.connect("s-2", idleHistory(SAVED, { threadId: "s-2" }));
    const other = render(hostElement({ id: "s-2" }));
    await screen.findByText("Earlier answer");
    await screen.findByLabelText("Notes");
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Default note");
    expect(stored().sessions["s-1"].surfaces[FORM].values["/notes"]).toBe("Private words");
    other.unmount();

    // Another person in the same tab never reads it, and the record goes.
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement({ scope: OTHER_USER }));
    await screen.findByText("Earlier answer");
    await screen.findByLabelText("Notes");
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Default note");
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "").not.toContain("Private words");
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "").not.toContain(USER.userId);
  });

  it("keep nothing without a signed-in person", async () => {
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement({ scope: null }));
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Nobody's words" } });
    await flushDrafts();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("never come back for a surface that the agent deleted, replaced, or never rendered", async () => {
    const REPLACED = "turn:a2:replaced";
    const saved = [...EARLIER, { id: "a1", role: "assistant", content: "Forms." },
      activity(PANEL, FORM, formOps()), activity("chat", INLINE, inlineOps()),
      activity("chat", REPLACED, [createSurface(REPLACED, [{ id: "root", component: "TextField", label: "Replaced field", value: { "@path": "/x" } }])])];
    server.connect("s-1", idleHistory(saved));
    const first = render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Words for the form" } });
    fireEvent.change(field("Chat name"), { target: { value: "Words for the chat view" } });
    fireEvent.change(field("Replaced field"), { target: { value: "Words for the old field" } });
    await flushDrafts();
    first.unmount();
    expect(Object.keys(stored().sessions["s-1"].surfaces).sort()).toEqual([FORM, INLINE, REPLACED].sort());

    // The panel form is deleted. The chat view stays. The third view keeps its
    // id and gets other content.
    server.connect("s-1", idleHistory([...EARLIER, { id: "a1", role: "assistant", content: "Forms." },
      activity(PANEL, FORM, [...formOps(), deleteSurface(FORM)]), activity("chat", INLINE, inlineOps()),
      activity("chat", REPLACED, [createSurface(REPLACED, [{ id: "root", component: "TextField", label: "New field", value: { "@path": "/y" } }])])]));
    render(hostElement());
    await screen.findByLabelText("Chat name");
    await waitFor(() => expect(field<HTMLInputElement>("Chat name").value).toBe("Words for the chat view"));
    expect(screen.queryByLabelText("Notes")).toBeNull();
    expect(within(panel()).getByText("Nothing here yet")).toBeTruthy();
    expect(field<HTMLInputElement>("New field").value).toBe("");
    expect(screen.queryByLabelText("Replaced field")).toBeNull();
    await flushDrafts();
    const kept = stored().sessions["s-1"].surfaces;
    expect(Object.keys(kept)).toEqual([INLINE]);
    expect(JSON.stringify(kept)).not.toMatch(/Words for the (form|old field)/);
  });

  it("do not bring back a surface whose message is gone from the history", async () => {
    server.connect("s-1", idleHistory(SAVED));
    const first = render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Words for a view that will go" } });
    await flushDrafts();
    first.unmount();

    server.connect("s-1", idleHistory([...EARLIER, { id: "a1", role: "assistant", content: "Only text now." }]));
    render(hostElement());
    await screen.findByText("Only text now.");
    await waitFor(() => expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull());
    expect(screen.queryByLabelText("Notes")).toBeNull();
  });

  it("end at sign-out, and a loop that was running writes nothing afterward", async () => {
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "Gone at sign-out" } });
    await flushDrafts();
    expect(stored()).not.toBeNull();

    clearGenerativeUiDrafts();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    fireEvent.change(field("Notes"), { target: { value: "Typed after sign-out" } });
    await flushDrafts();
    cleanup();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("still work when the browser blocks storage, and say that a reload resets the edits", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByLabelText("Notes");
    expect(screen.queryByText(/blocks tab storage/)).toBeNull();
    fireEvent.change(field("Notes"), { target: { value: "Typed with no storage" } });
    await flushDrafts();
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Typed with no storage");
    expect(await screen.findByText(/This browser blocks tab storage/)).toBeTruthy();
  });

  it("drop a session instead of keeping an old copy when the quota is full, and say so", async () => {
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByLabelText("Notes");
    fireEvent.change(field("Notes"), { target: { value: "First words" } });
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[FORM].values["/notes"]).toBe("First words");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    fireEvent.change(field("Notes"), { target: { value: "Words that do not fit" } });
    await flushDrafts();
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Words that do not fit");
    expect(await screen.findByText(/could not be saved in this tab/)).toBeTruthy();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "").not.toContain("First words");
  });

  it("ignore a corrupt record, and keep saving afterward", async () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, "{not json");
    server.connect("s-1", idleHistory(SAVED));
    render(hostElement());
    await screen.findByLabelText("Notes");
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Default note");
    fireEvent.click(field("Tests pass"));
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[FORM].values).toEqual({ "/tests": true });
  });

  it("wait in a long thread for the row of a chat view to mount, and are not lost meanwhile", async () => {
    // A first mount, with no virtualization, writes the draft of the chat view.
    server.connect("s-1", idleHistory(SAVED));
    const first = render(hostElement());
    await screen.findByLabelText("Chat name");
    fireEvent.change(field("Chat name"), { target: { value: "Typed far below" } });
    await flushDrafts();
    first.unmount();
    const draft = stored().sessions["s-1"].surfaces[INLINE];

    // A real layout makes CopilotChat mount only the rows near the top. A row
    // is 100 px high, any other element 600 px.
    const heightOf = (element: Element) => (element as HTMLElement).dataset?.index === undefined ? 600 : 100;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return heightOf(this); });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = heightOf(this);
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) } as DOMRect;
    });
    const filler = Array.from({ length: 30 }, (_, index) => [
      { id: `fu${index}`, role: "user", content: `Filler question ${index}` },
      { id: `fa${index}`, role: "assistant", content: `Filler answer ${index}` }
    ]).flat();
    server.connect("s-1", idleHistory([{ id: "a0", role: "assistant", content: "First answer." }, ...filler,
      { id: "a9", role: "assistant", content: "Last answer." }, activity("chat", INLINE, inlineOps())]));
    render(hostElement());
    await screen.findByText("First answer.");
    // The chat view is far below, so the manager does not hold it yet.
    expect(screen.queryByLabelText("Chat name")).toBeNull();
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[INLINE]).toEqual(draft);

    const rows = () => document.querySelectorAll("[data-index]");
    const scroller = rows()[0]!.closest("[style*='overflow: auto']") as HTMLElement;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 6000 });
    await act(async () => { fireEvent.scroll(scroller); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await waitFor(() => expect(field<HTMLInputElement>("Chat name").value).toBe("Typed far below"));
  });
});
