// @vitest-environment jsdom
//
// The Checklist of generated UI in the chat host, with the real CopilotKit
// provider, surface manager and CopilotChat, the real DeepAgentsBrowserAgent,
// and a fixture for the network. The user edits the checklist, reads what the
// next message sends, puts the values in the message box with "Use in
// reply", and sends them with the normal Send button.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATIVE_UI_PANEL_TARGET, MAX_GENERATIVE_UI_CONTEXT_LENGTH } from "@cogniplane/shared-types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { EARLIER_RECORDS_HEADING, MAX_EARLIER_RECORDS_CHARS } from "../lib/agui/deep-agents-browser-agent";
import { CopilotChatHost } from "./copilot-chat-host";
import { DRAFT_STORAGE_KEY, type DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();

const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };

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

function hostElement(options: { id?: string; canEdit?: boolean } = {}) {
  const sessionId = options.id ?? "s-1";
  return (
    <CopilotChatHost
      key={sessionId}
      session={{ id: sessionId, initialToolStatuses: [], initialApprovals: [], canEdit: options.canEdit ?? true }}
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

const LIST = "turn:a1:list";
const ITEMS = [
  { id: "tests", label: "Tests pass" },
  { id: "rollback", label: "Rollback ready", description: "Owner: Ada" },
  { id: "docs", label: "Release notes published" }
];
type ChecklistNode = Record<string, unknown>;
const checklist = (node: ChecklistNode = {}, dataModel: object = { release: { checked: { tests: true }, notes: "" } }, surfaceId = LIST) => [{
  version: "v1.0",
  createSurface: { surfaceId, dataModel, components: [{
    id: "root", component: "Checklist", title: "Release 4.2", items: ITEMS,
    checked: { "@path": "/release/checked" }, notes: { "@path": "/release/notes" }, ...node
  }] }
}];
const activity = (operations: object[], target = "chat", surfaceId = LIST) => ({
  id: `genui:${surfaceId}`, role: "activity", activityType: "generative-ui-surface",
  content: { surfaceId, target, catalogId: "cogniplane/standard@1", operations, status: "ready", rejected: [] }
});
const history = (operations: object[] = checklist(), target = "chat", surfaceId = LIST) => [
  { id: "u0", role: "user", content: "Make a release checklist" },
  { id: "a0", role: "assistant", content: "Here is the checklist." },
  activity(operations, target, surfaceId)
];

const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const notesField = () => screen.getByLabelText("Notes") as HTMLTextAreaElement;
const useInReply = () => screen.getByRole("button", { name: "Use in reply" }) as HTMLButtonElement;
const messagePosts = () => server.count("POST /messages");
const flushDrafts = () => act(async () => { window.dispatchEvent(new Event("pagehide")); });
const contextLine = () => screen.findByText(/go with your next message/);

async function sendWithEnter(): Promise<void> {
  server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.runFinished("a9")); stream.finish(); }];
  await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
  await waitFor(() => expect(server.sent).toHaveLength(1));
}

const EDITED_TEXT = [
  "Checklist: Release 4.2",
  "1 of 3 checked",
  "",
  "- [ ] Tests pass",
  "- [x] Rollback ready",
  "- [ ] Release notes published",
  "",
  "Notes:\nShip on Friday."
].join("\n");

describe("button-based generated input", () => {
  it.each(["click", "keyboard"])("previews and saves a bound segment after a %s without native input events", async (interaction) => {
    const operations = [{ version: "v1.0", createSurface: {
      surfaceId: LIST,
      dataModel: { priority: "low" },
      components: [{ id: "root", component: "SegmentedControl", label: "Priority",
        options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }],
        value: { "@path": "/priority" } }]
    } }];
    server.connect("s-1", idleHistory(history(operations)));
    render(hostElement());
    await screen.findByRole("radio", { name: "Low" });
    // Let the initial history and save timers finish. Only the interaction
    // below must trigger the preview and the next save.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(screen.queryByText(/go with your next message/)).toBeNull();
    if (interaction === "click") fireEvent.click(screen.getByRole("radio", { name: "High" }));
    else fireEvent.keyDown(screen.getByRole("radio", { name: "Low" }), { key: "ArrowRight" });

    await contextLine();
    expect(screen.getByText("high")).toBeTruthy();
    await waitFor(() => {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
      expect(saved?.sessions["s-1"].surfaces[LIST].values).toEqual({ "/priority": "high" });
    });
    expect(messagePosts()).toBe(0);
    fireEvent.change(composer(), { target: { value: "Read my priority" } });
    await sendWithEnter();
    expect(String(server.sent[0]!.generativeUiContext)).toContain('"userValues":{"/priority":"high"}');
  });
});

describe("a Checklist in the chat", () => {
  it("renders the start values, and a value that nobody edited is not listed for the next message", async () => {
    server.connect("s-1", idleHistory(history()));
    render(hostElement());
    await screen.findByRole("checkbox", { name: "Tests pass" });
    expect(box("Tests pass").checked).toBe(true);
    expect(box("Rollback ready").checked).toBe(false);
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
    expect(screen.getByText("Owner: Ada")).toBeTruthy();
    expect(notesField().value).toBe("");
    expect(screen.queryByText(/go with your next message/)).toBeNull();
  });

  it("shows the edited values beside the message box, puts them in the box without a request, and sends them only on Send", async () => {
    server.connect("s-1", idleHistory(history()));
    render(hostElement());
    await screen.findByRole("checkbox", { name: "Tests pass" });

    fireEvent.click(box("Tests pass"));
    fireEvent.click(box("Rollback ready"));
    fireEvent.change(notesField(), { target: { value: "Ship on Friday." } });
    expect(box("Tests pass").checked).toBe(false);
    expect(screen.getByText("1 of 3 done")).toBeTruthy();

    // The values that the next message sends, false included.
    const summary = await contextLine();
    expect(summary.textContent).toBe("Your entries in 1 generated view go with your next message.");
    fireEvent.click(summary.closest("summary")!);
    const view = screen.getByRole("region", { name: "View in the chat" });
    const rows = [...view.querySelectorAll("dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent}`);
    expect(rows).toEqual([
      "release › checked › tests=No", "release › checked › rollback=Yes", "release › checked › docs=No", "release › notes=Ship on Friday."
    ]);

    fireEvent.click(useInReply());
    expect(composer().value).toBe(EDITED_TEXT);
    expect(screen.getByText("Added to the message box. Read it, then press Send.")).toBeTruthy();
    const notice = screen.getByRole("group", { name: "Draft from a generated view" });
    expect(notice.textContent).toContain('Checklist "Release 4.2"');
    expect(notice.textContent).toContain("Nothing is sent until you press Send.");
    expect(messagePosts()).toBe(0);

    // The user changes the draft, then sends it.
    fireEvent.change(composer(), { target: { value: `${EDITED_TEXT}\nPlease review.` } });
    await sendWithEnter();
    expect(messagePosts()).toBe(1);
    const body = server.sent[0]!;
    expect(body.text).toBe(`${EDITED_TEXT}\nPlease review.`);
    expect(body.generativeUiTransport).toBe("tool");
    const context = String(body.generativeUiContext);
    expect(context).toContain(`"userValues":{"/release/checked":{"tests":false,"rollback":true,"docs":false},"/release/notes":"Ship on Friday."}`);
    // The guide leaves the full record budget, so the list above shows the records as sent.
    const guideLength = context.length - context.slice(context.indexOf(`\n\n${EARLIER_RECORDS_HEADING}`)).length;
    expect(MAX_GENERATIVE_UI_CONTEXT_LENGTH - guideLength - 400).toBeGreaterThan(MAX_EARLIER_RECORDS_CHARS);
  });

  it("keeps a draft of the user, and adds the values after it only when the user asks", async () => {
    server.connect("s-1", idleHistory(history()));
    render(hostElement());
    await screen.findByRole("checkbox", { name: "Tests pass" });
    fireEvent.change(composer(), { target: { value: "My own question" } });

    fireEvent.click(useInReply());
    expect(composer().value).toBe("My own question");
    expect(screen.getByText("The message box has your text. Nothing changed.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add after my text" }));
    expect(composer().value).toBe(`My own question\n\n${[
      "Checklist: Release 4.2", "1 of 3 checked", "", "- [x] Tests pass", "- [ ] Rollback ready", "- [ ] Release notes published", "", "Notes: none"
    ].join("\n")}`);
    expect(messagePosts()).toBe(0);
  });

  it("offers no reply action in a read-only chat", async () => {
    server.connect("s-1", idleHistory(history()));
    render(hostElement({ canEdit: false }));
    await screen.findByRole("checkbox", { name: "Tests pass" });
    expect(screen.queryByRole("button", { name: "Use in reply" })).toBeNull();
    expect(screen.getByText("Only project owners and editors can send messages in this chat.")).toBeTruthy();
  });

  it("waits while the agent works, and places nothing", async () => {
    server.connect("s-1", (stream: FixtureStream) => stream.push(
      ...ev.history({ messages: [...history(), { id: "u1", role: "user", content: "Next" }], activeTurn: "attached" }),
      ev.runStarted("a1"), ev.turnStarted("a1"), ev.userPersisted("u1", "Next"), ev.textStart("live-1"), ev.text("live-1", "Working")
    ));
    render(hostElement());
    await screen.findByText("Working");
    await screen.findByRole("checkbox", { name: "Tests pass" });
    expect(useInReply().disabled).toBe(true);
    expect(screen.getByText("You can use this in a reply when the agent finishes.")).toBeTruthy();
    fireEvent.click(useInReply());
    expect(composer().value).toBe("");
  });

  it("refuses props that a schema rule rejects, and renders no control", async () => {
    const duplicate = checklist({ items: [ITEMS[0], { id: "tests", label: "Again" }] });
    const unknownKey = checklist({}, { release: { checked: { nope: true } } }, "turn:a1:other");
    const wrongType = checklist({}, { release: { checked: { tests: "yes" } } }, "turn:a1:third");
    server.connect("s-1", idleHistory([
      ...history(duplicate),
      activity(unknownKey, "chat", "turn:a1:other"),
      activity(wrongType, "chat", "turn:a1:third")
    ]));
    render(hostElement());
    await screen.findByText("Here is the checklist.");
    // The SDK rejects the operation of a duplicate id, as the schema rule runs
    // before it applies the operation. The two values from the data model
    // reach the props, and the props check rejects them.
    await waitFor(() => expect(screen.getAllByText(/invalid props/)).toHaveLength(2));
    expect(screen.getByText(/couldn.t be shown/)).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Use in reply" })).toBeNull();
  });

  it("makes a checklist with literal values read-only after the first change, and keeps or sends nothing of it", async () => {
    server.connect("s-1", idleHistory(history(checklist({ checked: { tests: true }, notes: "Model note" }))));
    render(hostElement());
    await screen.findByRole("checkbox", { name: "Tests pass" });

    fireEvent.click(box("Tests pass"));
    expect(box("Tests pass").checked).toBe(true);
    expect(box("Tests pass").disabled).toBe(true);
    expect(notesField().readOnly).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("This checklist cannot keep changes, so it is read-only.");

    await flushDrafts();
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText(/go with your next message/)).toBeNull();
    // The reply action still states what the checklist shows.
    fireEvent.click(useInReply());
    expect(composer().value).toContain("- [x] Tests pass");
    expect(composer().value).toContain("Notes:\nModel note");
  });
});

describe("a Checklist in the side panel", () => {
  /** A history view does not open the panel. The user opens it. */
  async function openPanel() {
    await screen.findByText("Here is the checklist.");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Side panel/ }).textContent).toContain("(has a view)"));
    fireEvent.click(screen.getByRole("button", { name: /^Side panel/ }));
    await screen.findByRole("checkbox", { name: "Tests pass" });
  }

  it("brings the edits back after a reload, lists them again, and places them from the panel", async () => {
    server.connect("s-1", idleHistory(history(checklist(), GENERATIVE_UI_PANEL_TARGET)));
    const first = render(hostElement());
    await openPanel();
    fireEvent.click(box("Tests pass"));
    fireEvent.click(box("Rollback ready"));
    fireEvent.change(notesField(), { target: { value: "Ship on Friday." } });
    await flushDrafts();
    first.unmount();
    expect(JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY)!).sessions["s-1"].surfaces[LIST].values).toEqual({
      "/release/checked": { tests: false, rollback: true, docs: false }, "/release/notes": "Ship on Friday."
    });

    server.connect("s-1", idleHistory(history(checklist(), GENERATIVE_UI_PANEL_TARGET)));
    render(hostElement());
    await openPanel();
    await waitFor(() => expect(box("Tests pass").checked).toBe(false));
    expect(box("Rollback ready").checked).toBe(true);
    expect(notesField().value).toBe("Ship on Friday.");
    expect((await contextLine()).textContent).toBe("Your entries in 1 generated view go with your next message.");

    const panel = document.querySelector("aside[id^='side-panel-']") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Use in reply" }));
    expect(composer().value).toBe(EDITED_TEXT);
    expect(messagePosts()).toBe(0);
  });
});

describe("a Checklist after a change of session", () => {
  it("places the values of its own session, and lists no value of the other one", async () => {
    server.connect("s-1", idleHistory(history()));
    const view = render(hostElement());
    await screen.findByRole("checkbox", { name: "Tests pass" });
    fireEvent.change(notesField(), { target: { value: "Words of session one" } });
    await contextLine();

    server.connect("s-2", idleHistory(history(), { threadId: "s-2" }));
    view.rerender(hostElement({ id: "s-2" }));
    await screen.findByText("Here is the checklist.");
    await screen.findByRole("checkbox", { name: "Tests pass" });
    expect(notesField().value).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText(/go with your next message/)).toBeNull();
    fireEvent.click(useInReply());
    expect(composer().value).not.toContain("Words of session one");
    expect(composer().value).toContain("Notes: none");
  });
});
