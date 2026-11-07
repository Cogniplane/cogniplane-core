// @vitest-environment jsdom

import { A2UI_VERSION } from "@copilotkit/shared";
//
// Named views in the side panel, in the chat host with the real CopilotKit
// provider, surface manager and CopilotChat, the real DeepAgentsBrowserAgent,
// and a fixture for the network: the title and reply of the shown view, the
// picker of earlier views, and what a switch must never do. A switch is a
// navigation. It re-runs no tool, sends no message and loses no value.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { EARLIER_RECORDS_HEADING } from "../lib/agui/deep-agents-browser-agent";
import { CopilotChatHost } from "./copilot-chat-host";
import { DRAFT_STORAGE_KEY, type DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();

const PANEL = GENERATIVE_UI_PANEL_TARGET;
const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };
const NARROW = "(max-width: 767px)";

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

function hostElement(id = "s-1") {
  return (
    <CopilotChatHost
      key={id}
      session={{ id, initialToolStatuses: [], initialApprovals: [] }}
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

function stubViewport(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query === NARROW, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
  }));
}

const createSurface = (surfaceId: string, components: object[], dataModel: object = {}) =>
  ({ version: A2UI_VERSION, createSurface: { surfaceId, dataModel, components } });
const deleteSurface = (surfaceId: string) => ({ version: A2UI_VERSION, deleteSurface: { surfaceId } });
const surfaceContent = (surfaceId: string, operations: object[], status = "ready") =>
  ({ surfaceId, target: PANEL, catalogId: "cogniplane/standard@1", operations, status, rejected: [] });
const activity = (surfaceId: string, operations: object[]) =>
  ({ id: `genui:${surfaceId}`, role: "activity", activityType: "generative-ui-surface", content: surfaceContent(surfaceId, operations) });
const snapshotEvent = (surfaceId: string, operations: object[], status = "ready") =>
  ({ type: "ACTIVITY_SNAPSHOT", messageId: `genui:${surfaceId}`, activityType: "generative-ui-surface", content: surfaceContent(surfaceId, operations, status) });

/** An editable Checklist, so a test can edit a value in any view. */
const checklist = (surfaceId: string, title: string | undefined, items: string[]) => [createSurface(surfaceId, [{
  id: "root", component: "Checklist", ...(title === undefined ? {} : { title }),
  items: items.map((label, index) => ({ id: `i${index}`, label })),
  checked: { "@path": "/checked" }, notes: { "@path": "/notes" }
}], { checked: {}, notes: "" })];

const PLAN = "turn:a1:plan";
const LIST = "turn:a2:list";
const planOps = () => checklist(PLAN, "Release plan", ["Draft the notes", "Tag the build"]);
const listOps = () => checklist(LIST, "Launch checklist", ["Tests pass", "Rollback ready"]);
const EARLIER = [{ id: "u0", role: "user", content: "Earlier question" }, { id: "a0", role: "assistant", content: "Earlier answer" }];
const HISTORY = [
  ...EARLIER,
  { id: "u1", role: "user", content: "Make a plan" },
  { id: "a1", role: "assistant", content: "Here is the plan." },
  activity(PLAN, planOps()),
  { id: "u2", role: "user", content: "Now a checklist" },
  { id: "a2", role: "assistant", content: "Here is the checklist." },
  activity(LIST, listOps())
];

const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
const toggle = () => screen.getByRole("button", { name: /^Side panel/ });
const panel = () => document.querySelector("aside[id^='side-panel-']") as HTMLElement;
const picker = () => within(panel()).queryByLabelText("Switch view") as HTMLSelectElement | null;
const options = () => [...picker()!.options].map((option) => option.textContent);
const headerTitle = () => panel().querySelector("h3")?.textContent;
const provenance = () => within(panel()).queryByText(/^From reply/)?.textContent ?? null;
const banner = () => within(panel()).queryByText(/You are looking at an earlier view/)?.textContent ?? null;
const showLatestButton = () => within(panel()).queryByRole("button", { name: "Show latest view", hidden: true });
const choose = (surfaceId: string) => fireEvent.change(picker()!, { target: { value: surfaceId } });
const field = <T extends HTMLElement>(label: string) => within(panel()).getByLabelText(label) as T;
const flushDrafts = () => act(async () => { window.dispatchEvent(new Event("pagehide")); });
const stored = () => JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");

async function openHistory(messages: object[] = HISTORY, options: { hasMoreHistory?: boolean } = {}) {
  server.connect("s-1", idleHistory(messages, options));
  const rendered = render(hostElement());
  await waitFor(() => expect(headerTitle()).toBeTruthy());
  return rendered;
}

/** Sends a message and returns the stream of its reply. */
async function startTurn(text = "Show another view"): Promise<FixtureStream> {
  let reply!: FixtureStream;
  server.messageReplies = [(stream) => { reply = stream; }];
  fireEvent.change(composer(), { target: { value: text } });
  await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
  await waitFor(() => expect(reply).toBeDefined());
  return reply;
}

describe("the shown view has a name and a reply", () => {
  it("names a single view and its reply, with no picker and no note", async () => {
    await openHistory([...EARLIER, { id: "u1", role: "user", content: "Make a plan" }, { id: "a1", role: "assistant", content: "Plan." }, activity(PLAN, planOps())]);
    expect(headerTitle()).toBe("Release plan");
    expect(provenance()).toBe("From reply 2");
    expect(picker()).toBeNull();
    expect(showLatestButton()).toBeNull();
    expect(panel().textContent).not.toMatch(/turn:|a1:plan/);
  });

  it("names the latest view by default, and lists the views newest first", async () => {
    await openHistory();
    expect(headerTitle()).toBe("Launch checklist");
    expect(provenance()).toBe("From reply 3");
    expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy();
    expect(picker()!.value).toBe(LIST);
    expect(options()).toEqual(["Reply 3 · Launch checklist (latest)", "Reply 2 · Release plan"]);
    expect(showLatestButton()).toBeNull();
    expect(panel().textContent).not.toMatch(/turn:|a2:list/);
  });

  it("falls back to 'Generated view' when the root has no title it can trust", async () => {
    const BOUND = "turn:a2:bound";
    const COLUMN = "turn:a3:column";
    await openHistory([...HISTORY.slice(0, 5),
      { id: "u2", role: "user", content: "Bound" }, { id: "a2", role: "assistant", content: "Bound title." },
      activity(BOUND, [createSurface(BOUND, [{ id: "root", component: "Checklist", title: { "@path": "/title" }, items: [{ id: "i0", label: "One" }], checked: { "@path": "/checked" } }], { title: "Hidden title", checked: {} })]),
      { id: "u3", role: "user", content: "Column" }, { id: "a3", role: "assistant", content: "Column root." },
      activity(COLUMN, [createSurface(COLUMN, [{ id: "root", component: "Column", children: ["t"] }, { id: "t", component: "Text", text: "A heading in a Column" }])])
    ]);
    expect(headerTitle()).toBe("Generated view");
    expect(options()).toEqual(["Reply 4 · Generated view (latest)", "Reply 3 · Generated view", "Reply 2 · Release plan"]);
  });

  it("shows a title as plain bounded text: no markup, no link, no control characters", async () => {
    const LONG = `${"Quarterly launch review ".repeat(4)}end`;
    const MARKUP = "turn:a2:markup";
    await openHistory([...HISTORY.slice(0, 5),
      { id: "u2", role: "user", content: "Markup" }, { id: "a2", role: "assistant", content: "Markup title." },
      activity(MARKUP, checklist(MARKUP, `<img src=x onerror=alert(1)>[go](https://example.test)\u202E**bold**${LONG}`.slice(0, 110), ["One"]))
    ]);
    const title = headerTitle()!;
    expect(title.startsWith("<img src=x onerror=alert(1)>[go](https://example.test) **bold**")).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/[\u202E\u200B]/);
    const bar = panel().querySelector("h3")!.parentElement!.parentElement!;
    expect(bar.querySelector("img, a, strong, em")).toBeNull();
    expect(options()[0]!.length).toBeLessThan(120);
  });

  it("shows no reply number when the loaded history starts in the middle, and numbers the duplicates", async () => {
    const SAME = "turn:a2:same";
    await openHistory([...HISTORY.slice(0, 5),
      { id: "u2", role: "user", content: "Again" }, { id: "a2", role: "assistant", content: "Same title." },
      activity(SAME, checklist(SAME, "Release plan", ["Other item"]))
    ], { hasMoreHistory: true });
    expect(provenance()).toBeNull();
    expect(panel().textContent).not.toMatch(/From reply|Reply \d/);
    expect(options()).toEqual(["Release plan (2 of 2) (latest)", "Release plan (1 of 2)"]);
  });
});

describe("choosing an earlier view", () => {
  it("shows the earlier view, says so, and goes back to the latest view with focus on the picker", async () => {
    stubViewport(false);
    await openHistory();
    fireEvent.click(toggle());
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(provenance()).toBe("From reply 2");
    expect(within(panel()).getByLabelText("Draft the notes")).toBeTruthy();
    expect(within(panel()).queryByLabelText("Tests pass")).toBeNull();
    expect(picker()!.value).toBe(PLAN);
    expect(banner()).toBe("You are looking at an earlier view. 1 newer view is available.");

    fireEvent.click(showLatestButton()!);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy();
    expect(showLatestButton()).toBeNull();
    expect(document.activeElement).toBe(picker());

    // Choosing the latest view in the picker is the same return.
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    choose(LIST);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(showLatestButton()).toBeNull();
  });

  it("is a navigation: it sends nothing, connects nothing again, and keeps the edited values of every view", async () => {
    await openHistory();
    fireEvent.change(field("Notes"), { target: { value: "Notes for the checklist" } });
    fireEvent.click(field("Tests pass"));
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("");
    fireEvent.change(field("Notes"), { target: { value: "Notes for the plan" } });
    fireEvent.click(field("Tag the build"));

    // Back and forth: each view keeps its own values.
    choose(LIST);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Notes for the checklist");
    expect(field<HTMLInputElement>("Tests pass").checked).toBe(true);
    expect(field<HTMLInputElement>("Rollback ready").checked).toBe(false);
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Notes for the plan");
    expect(field<HTMLInputElement>("Tag the build").checked).toBe(true);
    expect(field<HTMLInputElement>("Draft the notes").checked).toBe(false);

    expect(server.sent).toHaveLength(0);
    expect(server.count("POST /messages")).toBe(0);
    expect(server.count("GET /sessions/s-1/connect")).toBe(1);
  });

  it("sends each edited view once, as a panel view, however the user looked at them", async () => {
    await openHistory();
    fireEvent.change(field("Notes"), { target: { value: "Notes for the checklist" } });
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    fireEvent.change(field("Notes"), { target: { value: "Notes for the plan" } });
    // The user leaves the plan open: the checklist is the inactive view.
    await waitFor(() => expect(screen.getByText(/Your entries in 2 generated views go with your next message/)).toBeTruthy());

    server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.runFinished("a9")); stream.finish(); }];
    fireEvent.change(composer(), { target: { value: "Check them" } });
    await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
    await waitFor(() => expect(server.sent).toHaveLength(1));

    const context = String(server.sent[0]!.generativeUiContext);
    expect(context).not.toMatch(/parked/);
    const section = context.slice(context.indexOf(`\n\n${EARLIER_RECORDS_HEADING}`), context.lastIndexOf("\n\nRender only to"));
    const records = section.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as {
      source: string; target: string; userValues: Record<string, unknown>;
    });
    expect(records.map((record) => record.source).sort()).toEqual([PLAN, LIST]);
    expect(records.every((record) => record.target === PANEL)).toBe(true);
    expect(records.find((record) => record.source === PLAN)!.userValues).toEqual({ "/notes": "Notes for the plan" });
    expect(records.find((record) => record.source === LIST)!.userValues).toEqual({ "/notes": "Notes for the checklist" });
  });

  it("keeps the draft of an inactive view through a reload and gives it back with the view", async () => {
    const first = await openHistory();
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    fireEvent.change(field("Notes"), { target: { value: "Typed in the earlier view" } });
    await flushDrafts();
    first.unmount();
    const surfaces = stored().sessions["s-1"].surfaces;
    expect(Object.keys(surfaces)).toEqual([PLAN]);
    expect(surfaces[PLAN].target).toBe(PANEL);

    await openHistory();
    // The latest view is the default after a reload.
    expect(headerTitle()).toBe("Launch checklist");
    choose(PLAN);
    await waitFor(() => expect(field<HTMLTextAreaElement>("Notes").value).toBe("Typed in the earlier view"));
    await flushDrafts();
    expect(stored().sessions["s-1"].surfaces[PLAN].target).toBe(PANEL);
  });

  it("keeps the draft of a view that the panel does not show when another view is edited", async () => {
    await openHistory();
    fireEvent.change(field("Notes"), { target: { value: "Latest notes" } });
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    fireEvent.click(field("Draft the notes"));
    await flushDrafts();
    const surfaces = stored().sessions["s-1"].surfaces;
    expect(Object.keys(surfaces).sort()).toEqual([PLAN, LIST]);
    expect(surfaces[LIST].values).toEqual({ "/notes": "Latest notes" });
    expect(surfaces[LIST].target).toBe(PANEL);
    expect(surfaces[PLAN].values).toEqual({ "/checked": { i0: true, i1: false } });
  });
});

describe("a newer view while the user looks at an earlier one", () => {
  it("does not take the selection or the focus, marks the latest view, and offers the way back", async () => {
    stubViewport(false);
    await openHistory();
    fireEvent.click(toggle());
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    fireEvent.change(field("Notes"), { target: { value: "Still typing here" } });
    const reply = await startTurn();
    picker()!.focus();

    const FRESH = "turn:a3:fresh";
    await act(async () => {
      reply.push(ev.runStarted("a3"), snapshotEvent(FRESH, checklist(FRESH, "Fresh view", ["New item"]), "streaming"));
    });
    await waitFor(() => expect(options()[0]).toBe("Reply 4 · Fresh view (latest) (being written)"));
    expect(headerTitle()).toBe("Release plan");
    expect(picker()!.value).toBe(PLAN);
    expect(document.activeElement).toBe(picker());
    expect(field<HTMLTextAreaElement>("Notes").value).toBe("Still typing here");
    expect(banner()).toBe("You are looking at an earlier view. 2 newer views are available.");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    await act(async () => { reply.push(snapshotEvent(FRESH, checklist(FRESH, "Fresh view", ["New item"])), ev.runFinished("a3")); reply.finish(); });
    await waitFor(() => expect(options()[0]).toBe("Reply 4 · Fresh view (latest)"));
    fireEvent.click(showLatestButton()!);
    await waitFor(() => expect(headerTitle()).toBe("Fresh view"));
    expect(within(panel()).getByLabelText("New item")).toBeTruthy();
    expect(document.activeElement).toBe(picker());
  });

  it("follows the latest view when the user is on it", async () => {
    stubViewport(false);
    await openHistory();
    fireEvent.click(toggle());
    choose(PLAN);
    choose(LIST);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    const reply = await startTurn();
    const FRESH = "turn:a3:fresh";
    await act(async () => { reply.push(ev.runStarted("a3"), snapshotEvent(FRESH, checklist(FRESH, "Fresh view", ["New item"])), ev.runFinished("a3")); reply.finish(); });
    await waitFor(() => expect(headerTitle()).toBe("Fresh view"));
    expect(banner()).toBeFalsy();
  });
});

describe("a chosen view that is no longer there", () => {
  const attached = (messages: object[]) => (stream: FixtureStream) => stream.push(
    ...ev.history({ messages, activeTurn: "attached" }), ev.runStarted("a3"), ev.turnStarted("a3"),
    ev.userPersisted("u3", "Third question"), ev.textStart("live-1"), ev.text("live-1", "Working")
  );
  const opening = [...HISTORY, { id: "u3", role: "user", content: "Third question" }];

  async function reconnectWith(after: object[], beforeDisconnect?: () => void, idle = false) {
    server.running.set("s-1", true);
    server.connect("s-1", attached(opening), idle ? idleHistory(after) : attached(after));
    render(hostElement());
    await screen.findByText("Working");
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    beforeDisconnect?.();
    if (idle) server.running.set("s-1", false);
    await act(async () => { server.streamsOf("connect:s-1")[0]!.fail(); });
  }

  it("keeps the chosen view after a reconnect when it is still in history", async () => {
    await reconnectWith(opening);
    await waitFor(() => expect(server.streamsOf("connect:s-1")).toHaveLength(2));
    await screen.findByText("Working");
    expect(headerTitle()).toBe("Release plan");
    expect(picker()!.value).toBe(PLAN);
    expect(within(panel()).getByLabelText("Draft the notes")).toBeTruthy();
  });

  it("does not send or save edited values of a view removed by reconnect history", async () => {
    const after = HISTORY.filter((message) => message.id !== `genui:${PLAN}`);
    await reconnectWith(after, () => {
      fireEvent.change(field("Notes"), { target: { value: "REMOVED-PLAN-PRIVATE-NOTES" } });
    }, true);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    await flushDrafts();
    expect(JSON.stringify(stored())).not.toContain("REMOVED-PLAN-PRIVATE-NOTES");
    await waitFor(() => expect(screen.queryByText(/Your entries in .*generated view/)).toBeNull());

    const reply = await startTurn("Review the remaining view");
    expect(String(server.sent[0]!.generativeUiContext)).not.toContain("REMOVED-PLAN-PRIVATE-NOTES");
    expect(String(server.sent[0]!.generativeUiContext)).not.toContain(PLAN);
    expect(String(server.sent[0]!.generativeUiContext)).not.toContain("side-panel:removed");
    await act(async () => { reply.push(ev.runStarted("a4"), ev.runFinished("a4")); reply.finish(); });
  });

  it("falls back to the latest view when the history after a reconnect lacks the chosen one", async () => {
    await reconnectWith([...HISTORY.filter((message) => (message as { id: string }).id !== `genui:${PLAN}`), { id: "u3", role: "user", content: "Third question" }]);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(picker()).toBeNull();
    expect(showLatestButton()).toBeNull();
    expect(within(panel()).queryByLabelText("Draft the notes")).toBeNull();
    expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy();
  });

  it("shows the earlier view, and nothing of the removed one, when the latest view is gone from the history", async () => {
    await reconnectWith([...HISTORY.filter((message) => (message as { id: string }).id !== `genui:${LIST}`), { id: "u3", role: "user", content: "Third question" }]);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(picker()).toBeNull();
    expect(showLatestButton()).toBeNull();
    expect(within(panel()).queryByLabelText("Tests pass")).toBeNull();
    expect(within(panel()).getByLabelText("Draft the notes")).toBeTruthy();
  });

  it("shows the latest view when the agent deletes the chosen one", async () => {
    stubViewport(false);
    await openHistory();
    fireEvent.click(toggle());
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    const reply = await startTurn("Remove the plan");
    await act(async () => {
      reply.push(ev.runStarted("a3"), snapshotEvent(PLAN, [...planOps(), deleteSurface(PLAN)]), ev.runFinished("a3"));
      reply.finish();
    });
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(picker()).toBeNull();
    expect(showLatestButton()).toBeNull();
    expect(within(panel()).queryByLabelText("Draft the notes")).toBeNull();
    expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy();
  });
});

describe("states of the views", () => {
  const BROKEN = "turn:a2:broken";
  const brokenOps = () => [createSurface(BROKEN, [{ id: "root", component: "NoSuchComponent" }])];

  it("uses transcript order after an earlier preview is withdrawn and retried", async () => {
    await openHistory();
    const reply = await startTurn();
    await act(async () => { reply.push(ev.runStarted("a3"), snapshotEvent(PLAN, [])); });
    await waitFor(() => expect(picker()).toBeNull());
    await act(async () => {
      reply.push(snapshotEvent(PLAN, planOps()), ev.runFinished("a3"));
      reply.finish();
    });
    await waitFor(() => expect(picker()).not.toBeNull());
    expect(headerTitle()).toBe("Launch checklist");
    expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy();
    expect(within(panel()).queryByLabelText("Draft the notes")).toBeNull();
    choose(PLAN);
    await waitFor(() => expect(within(panel()).getByLabelText("Draft the notes")).toBeTruthy());
    choose(LIST);
    await waitFor(() => expect(within(panel()).getByLabelText("Tests pass")).toBeTruthy());
  });

  it("never renders an unrelated fence under the selected activity's title and reply", async () => {
    await openHistory();
    const reply = await startTurn();
    const fence = ["```a2ui target=side-panel",
      JSON.stringify(createSurface("foreign", [{ id: "root", component: "Text", text: "FOREIGN-FENCE-CONTENT" }])),
      "```"].join("\n");
    await act(async () => {
      reply.push(ev.runStarted("a3"), ev.textStart("a3:text"), ev.text("a3:text", fence), ev.textEnd("a3:text"), ev.runFinished("a3"));
      reply.finish();
    });
    await waitFor(() => expect(within(panel()).getByText("This view is unavailable. Ask the agent to create it again.")).toBeTruthy());
    expect(headerTitle()).toBe("Launch checklist");
    expect(within(panel()).queryByText("FOREIGN-FENCE-CONTENT")).toBeNull();
    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(within(panel()).queryByText("FOREIGN-FENCE-CONTENT")).toBeNull();
  });

  it("does not list a deleted view or a withdrawn preview", async () => {
    const GONE = "turn:a1:gone";
    const WITHDRAWN = "turn:a1:withdrawn";
    await openHistory([...HISTORY.slice(0, 4),
      activity(GONE, [...checklist(GONE, "Gone view", ["Gone item"]), deleteSurface(GONE)]),
      activity(WITHDRAWN, []),
      activity(PLAN, planOps()), ...HISTORY.slice(5)]);
    expect(options()).toEqual(["Reply 3 · Launch checklist (latest)", "Reply 2 · Release plan"]);
    expect(within(panel()).queryByLabelText("Gone item")).toBeNull();
    expect(panel().textContent).not.toContain("Gone view");
  });

  it("says that the newest view could not be shown, lists it, and still opens the earlier views", async () => {
    await openHistory([...HISTORY.slice(0, 5),
      { id: "u2", role: "user", content: "Broken" }, { id: "a2", role: "assistant", content: "Broken view." }, activity(BROKEN, brokenOps())]);
    expect(within(panel()).getByText("The newest view could not be shown. Ask the agent to try again.")).toBeTruthy();
    expect(headerTitle()).toBe("Generated view");
    expect(options()).toEqual(["Reply 3 · Generated view (latest) (could not be shown)", "Reply 2 · Release plan"]);
    // The refused view leaves nothing of an older view in its place.
    expect(within(panel()).queryByLabelText("Draft the notes")).toBeNull();
    expect(within(panel()).queryByLabelText("Tests pass")).toBeNull();

    choose(PLAN);
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    expect(within(panel()).queryByText(/could not be shown\. Ask/)).toBeNull();
    expect(within(panel()).getByLabelText("Draft the notes")).toBeTruthy();
    expect(banner()).toBe("You are looking at an earlier view. 1 newer view is available.");

    fireEvent.click(showLatestButton()!);
    await waitFor(() => expect(within(panel()).getByText("The newest view could not be shown. Ask the agent to try again.")).toBeTruthy());
  });

  it("says that a chosen earlier view could not be shown, without saying that it is the newest", async () => {
    const OLD_BROKEN = "turn:a1:broken";
    await openHistory([...HISTORY.slice(0, 4), activity(OLD_BROKEN, [createSurface(OLD_BROKEN, [{ id: "root", component: "NoSuchComponent" }])]), ...HISTORY.slice(5)]);
    expect(options()).toEqual(["Reply 3 · Launch checklist (latest)", "Reply 2 · Generated view (could not be shown)"]);
    choose(OLD_BROKEN);
    await waitFor(() => expect(within(panel()).getByText("This view could not be shown.")).toBeTruthy());
    expect(within(panel()).queryByText(/newest view/)).toBeNull();
    expect(within(panel()).queryByLabelText("Tests pass")).toBeNull();
  });

  it("notes the refused operations of the shown view only", async () => {
    const PARTIAL = "turn:a1:partial";
    const partial = [...planOps().map((op) => JSON.parse(JSON.stringify(op).replaceAll(PLAN, PARTIAL))),
      { version: A2UI_VERSION, updateComponents: { surfaceId: PARTIAL, components: [{ id: "extra", component: "NoSuchComponent" }] } }];
    // The SDK reports a refused operation each time it applies one. A switch
    // that rebuilt the surface would apply the operations again and report again.
    const reports = () => warn.mock.calls.filter(([message]) => String(message).includes(`operation error in ${PARTIAL}`)).length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await openHistory([...HISTORY.slice(0, 4), activity(PARTIAL, partial), ...HISTORY.slice(5)]);
    expect(reports()).toBe(1);
    expect(within(panel()).queryByText("Some parts of this view could not be shown.")).toBeNull();
    choose(PARTIAL);
    await waitFor(() => expect(within(panel()).getByText("Some parts of this view could not be shown.")).toBeTruthy());
    choose(LIST);
    await waitFor(() => expect(within(panel()).queryByText("Some parts of this view could not be shown.")).toBeNull());
    choose(PARTIAL);
    await waitFor(() => expect(within(panel()).getByText("Some parts of this view could not be shown.")).toBeTruthy());
    fireEvent.click(showLatestButton()!);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(reports()).toBe(1);
  });

  it("keeps the views of one session out of another", async () => {
    const first = await openHistory();
    expect(options()).toHaveLength(2);
    first.unmount();

    const OTHER = "turn:b1:other";
    server.connect("s-2", idleHistory([{ id: "b0", role: "user", content: "Other session" }, { id: "b1", role: "assistant", content: "Other answer." },
      activity(OTHER, checklist(OTHER, "Other view", ["Other item"]))], { threadId: "s-2" }));
    render(hostElement("s-2"));
    await screen.findByText("Other answer.");
    await waitFor(() => expect(headerTitle()).toBe("Other view"));
    expect(picker()).toBeNull();
    expect(provenance()).toBe("From reply 1");
    expect(panel().textContent).not.toMatch(/Release plan|Launch checklist/);
  });
});

describe("the picker on a narrow screen", () => {
  it("stays inside the modal panel, is a large target, and returns focus after the way back", async () => {
    stubViewport(true);
    await openHistory();
    fireEvent.click(toggle());
    const dialog = screen.getByRole("dialog", { name: "Side panel" });
    const select = within(dialog).getByLabelText("Switch view") as HTMLSelectElement;
    expect(select.className).toContain("min-h-11");
    expect(select.className).toContain("truncate");

    // The picker is inside the dialog, so it is reachable and not inert.
    expect(select.closest("[inert]")).toBeNull();
    fireEvent.change(select, { target: { value: PLAN } });
    await waitFor(() => expect(headerTitle()).toBe("Release plan"));
    const back = within(dialog).getByRole("button", { name: "Show latest view" });
    expect(back.className).toContain("min-h-11");
    fireEvent.click(back);
    await waitFor(() => expect(headerTitle()).toBe("Launch checklist"));
    expect(document.activeElement).toBe(select);
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeTruthy();

    // Tab wraps among the controls of the panel, picker included.
    const close = within(dialog).getByRole("button", { name: "Close side panel" });
    close.focus();
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    // Tab from the last control comes back to Close, which is first in the panel.
    expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(dialog.querySelectorAll("button, select, input, textarea").length).toBeGreaterThan(3);
    expect(([...dialog.querySelectorAll("button, select")] as HTMLElement[])[1]).toBe(select);

    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
