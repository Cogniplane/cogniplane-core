// @vitest-environment jsdom

import { A2UI_VERSION } from "@copilotkit/shared";
//
// Blocks that the app puts in the composer slot of CopilotChat. The SDK draws
// the slot inside an overlay with `pointer-events: none` and lets only its own
// message pill opt back in. The property is inherited, so a block without its
// own `pointer-events-auto` is visible and works with the keyboard, but a mouse
// click goes through it to the transcript behind.
//
// The same holds while the on-screen keyboard lifts the composer: the box that
// sits above the keyboard has no pointer events of its own, so the transcript behind its empty
// margins stays clickable, and the blocks, the message box, Send, and Stop each
// keep `pointer-events: auto`.
//
// jsdom does no layout and no hit-testing, so these tests do not prove that a
// click lands. They check the inheritance: each control must resolve to
// `pointer-events: auto` through the real chat host, the real SDK overlay, and
// the SDK's own CSS rules (read from its shipped stylesheet). The Tailwind
// utility `pointer-events-auto` of the app is not built in a test, so the one
// rule of it is written below. A real browser check of the clicks stays
// necessary.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs } from "../test-helpers/agui-fixture-server";
import { installKeyboardViewport, type KeyboardViewport } from "../test-helpers/keyboard-viewport";
import { CopilotChatHost, type ChatSessionModel } from "./copilot-chat-host";
import { type DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();

const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };

/** The two rules of the SDK that decide the composer, read from its stylesheet. */
function sdkPointerRules(): string[] {
  const path = createRequire(import.meta.url).resolve("@copilotkit/react-core/v2/styles.css");
  const rules = readFileSync(path, "utf8").match(/\.cpk\\:pointer-events-(?:none|auto)\{[^}]*\}/g) ?? [];
  expect([...rules].sort()).toEqual([
    ".cpk\\:pointer-events-auto{pointer-events:auto}",
    ".cpk\\:pointer-events-none{pointer-events:none}"
  ]);
  return rules;
}

let style: HTMLStyleElement;
beforeAll(() => {
  style = document.createElement("style");
  // Tailwind builds this utility for the app: one declaration.
  style.textContent = [...sdkPointerRules(), ".pointer-events-auto{pointer-events:auto}"].join("\n");
  document.head.append(style);
});
afterAll(() => style.remove());

/** The value of `pointer-events` for an element: its own rule, else the one of
 *  the nearest ancestor, else `auto`. jsdom does not resolve this inheritance. */
function effectivePointerEvents(element: Element): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const declared = getComputedStyle(node).pointerEvents;
    if (declared) return declared;
  }
  return "auto";
}

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
  sessionStorage.clear();
});

function hostElement(session: Partial<ChatSessionModel> = {}) {
  const sessionId = session.id ?? "s-1";
  return (
    <CopilotChatHost
      key={sessionId}
      session={{ id: sessionId, initialToolStatuses: [], initialApprovals: [], ...session }}
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

const overlay = () => screen.getByTestId("copilot-input-overlay");

describe("pointer events in the composer slot", () => {
  it("resolves the SDK overlay to none and its message pill to auto, so the test models the inheritance", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    const box = await screen.findByTestId("copilot-chat-textarea");

    expect(effectivePointerEvents(overlay())).toBe("none");
    expect(effectivePointerEvents(box)).toBe("auto");
    expect(effectivePointerEvents(screen.getByTestId("copilot-send-button"))).toBe("auto");
    // A bare child of the overlay inherits none: this is the failure of a block that does not opt in.
    const bare = document.createElement("button");
    overlay().append(bare);
    expect(effectivePointerEvents(bare)).toBe("none");
    bare.remove();
  });

  it("lets a click reach Clear draft in the notice of a starter draft", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    fireEvent.click(await screen.findByRole("button", { name: "Build a checklist" }));

    const notice = screen.getByRole("group", { name: "Starter draft" });
    const clear = screen.getByRole("button", { name: "Clear draft" });
    expect(overlay().contains(clear)).toBe(true);
    expect(effectivePointerEvents(notice)).toBe("auto");
    expect(effectivePointerEvents(clear)).toBe("auto");
  });

  it("lets a click reach the Review summary of the entries that the next message sends", async () => {
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
    expect(overlay().contains(summary)).toBe(true);
    expect(effectivePointerEvents(summary)).toBe("auto");
    expect(effectivePointerEvents(summary.closest("details")!)).toBe("auto");
    // The list that opens inside the block is part of it.
    fireEvent.click(summary);
    expect(effectivePointerEvents(summary.closest("details")!.querySelector("dl")!)).toBe("auto");
  });

  it("lets a click reach Stop when the turn runs without a stream in this tab", async () => {
    server.running.set("s-1", true);
    server.savedRows.set("s-1", []);
    server.connect("s-1", (stream) => {
      stream.push(...ev.history({
        messages: [{ id: "u1", role: "user", content: "Question" }, { id: "a1", role: "assistant", content: "SAVED-PARTIAL" }],
        activeTurn: "unavailable"
      }));
      stream.finish();
    });
    render(hostElement({ isRunning: true }));
    const note = (await screen.findByText(/The agent is still working on this chat/)).closest("div[class*='border-t']")!;

    const stop = await waitFor(() => screen.getByRole("button", { name: "Stop" }));
    expect(overlay().contains(stop)).toBe(true);
    expect(effectivePointerEvents(note)).toBe("auto");
    expect(effectivePointerEvents(stop)).toBe("auto");
  });

  it("lets the read-only note take the pointer where it covers the transcript", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement({ canEdit: false }));

    const note = await screen.findByRole("note");
    expect(overlay().contains(note)).toBe(true);
    expect(effectivePointerEvents(note)).toBe("auto");
  });
});

describe("pointer events while the keyboard lifts the composer", () => {
  let keyboard: KeyboardViewport;
  beforeEach(() => { keyboard = installKeyboardViewport(); });
  afterEach(() => keyboard.uninstall());

  // The box that the composer slot renders in the overlay, and its first child.
  const liftedBox = () => overlay().firstElementChild as HTMLElement;
  const region = () => liftedBox().firstElementChild as HTMLElement;

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
  }

  it("keeps the lifted box out of the pointer path and the blocks and the message box in it", async () => {
    await showReviewAndDraft();
    keyboard.open(300);
    expect(liftedBox().style.marginBottom).toBe("300px");

    // The lifted box and the margins around the blocks pass clicks through.
    expect(effectivePointerEvents(liftedBox())).toBe("none");
    // The blocks and the message box take them.
    expect(effectivePointerEvents(region())).toBe("auto");
    expect(effectivePointerEvents(screen.getByRole("group", { name: "Draft from a generated view" }))).toBe("auto");
    expect(effectivePointerEvents(screen.getByRole("button", { name: "Clear draft" }))).toBe("auto");
    const summary = screen.getByText(/go with your next message/).closest("summary")!;
    expect(effectivePointerEvents(summary)).toBe("auto");
    expect(effectivePointerEvents(screen.getByTestId("copilot-chat-textarea"))).toBe("auto");
    expect(effectivePointerEvents(screen.getByTestId("copilot-send-button"))).toBe("auto");
  });

  it("keeps the pointer rules the same as without the keyboard", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement());
    fireEvent.click(await screen.findByRole("button", { name: "Build a checklist" }));
    const rules = () => [liftedBox(), region(), screen.getByRole("button", { name: "Clear draft" }), screen.getByTestId("copilot-send-button")]
      .map((element) => effectivePointerEvents(element));
    const before = rules();

    keyboard.open(300);
    expect(rules()).toEqual(before);

    keyboard.close();
    expect(rules()).toEqual(before);
  });

  it("sends a message with the Send button of the lifted composer", async () => {
    server.connect("s-1", idleHistory([]));
    server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.runFinished("a9")); stream.finish(); }];
    render(hostElement());
    const box = await screen.findByTestId("copilot-chat-textarea");
    keyboard.open(300);

    fireEvent.change(box, { target: { value: "Question from a phone" } });
    const send = screen.getByTestId("copilot-send-button") as HTMLButtonElement;
    expect(liftedBox().contains(send)).toBe(true);
    expect(effectivePointerEvents(send)).toBe("auto");
    await act(async () => { fireEvent.click(send); });

    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe("Question from a phone");
  });

  it("stops the turn with the Stop button of the lifted composer", async () => {
    server.connect("s-1", idleHistory([]));
    // The turn starts and never ends, so the Send button becomes Stop.
    server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.textStart("r-9"), ev.text("r-9", "Working")); }];
    render(hostElement());
    const box = await screen.findByTestId("copilot-chat-textarea");
    keyboard.open(300);
    fireEvent.change(box, { target: { value: "Long question" } });
    await act(async () => { fireEvent.click(screen.getByTestId("copilot-send-button")); });

    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(liftedBox().contains(stop)).toBe(true);
    expect(effectivePointerEvents(stop)).toBe("auto");
    fireEvent.click(stop);

    await waitFor(() => expect(server.count("POST /sessions/s-1/interrupt")).toBe(1));
  });
});
