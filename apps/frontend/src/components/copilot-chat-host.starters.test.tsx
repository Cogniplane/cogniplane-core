// @vitest-environment jsdom
//
// The starters of an empty chat, in the chat host with the real CopilotKit
// provider and CopilotChat, the real DeepAgentsBrowserAgent, and a fixture for
// the network. A starter puts a draft in the message box. The user reads it,
// can change it, and sends it with the normal Send key. The tests count the
// POST /messages calls to show that picking a starter sends nothing.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { CopilotChatHost, type ChatSessionModel } from "./copilot-chat-host";
import { CHAT_STARTERS } from "./chat-starters.logic";

installBrowserLayoutStubs();

let server: FixtureServer;
beforeEach(() => {
  server = new FixtureServer();
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      events={{}}
    />
  );
}

const HEADING = "Start with a draft";
const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
const starter = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const starterButtons = () => CHAT_STARTERS.flatMap((entry) => screen.queryAllByRole("button", { name: entry.label }) as HTMLButtonElement[]);
const notice = () => screen.queryByRole("group", { name: "Starter draft" });
const messagePosts = () => server.count("POST /messages");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

const CHECKLIST_DRAFT = "Help me build a checklist that I can tick off. First ask me what it is for and which steps it needs. "
  + "Do not invent details that I did not give you.";
const EARLIER = [
  { id: "u0", role: "user", content: "Earlier question" },
  { id: "a0", role: "assistant", content: "Earlier answer" }
];

async function openEmptyChat(session: Partial<ChatSessionModel> = {}) {
  server.connect(session.id ?? "s-1", idleHistory([]));
  const view = render(hostElement(session));
  await screen.findByText(HEADING);
  return view;
}

describe("the starters of an empty chat", () => {
  it("offers four named starters in an empty chat that can send, and sends nothing", async () => {
    await openEmptyChat();

    // The name of each button is its task, and the hint under it is the description.
    const described = starterButtons().map((button) => [
      button.getAttribute("aria-label") ?? button.firstElementChild?.textContent,
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent
    ]);
    expect(described).toEqual([
      ["Build a checklist", "Steps you can tick off"],
      ["Compare options", "Side by side in a table"],
      ["Summarize status", "Where each item stands"],
      ["Use the side panel", "A view beside the chat"]
    ]);
    expect(starterButtons().every((button) => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true);
    expect(screen.getByText("Nothing is sent until you press Send.", { exact: false })).toBeTruthy();
    // The text of a starter is a request in plain language, so the box is empty until the user picks one.
    expect(composer().value).toBe("");
    await settle();
    expect(messagePosts()).toBe(0);
    expect(server.openStreams("messages:s-1")).toHaveLength(0);
  });

  it("puts the draft in the box, names the app as its writer, focuses the box, and starts no turn", async () => {
    await openEmptyChat();
    // The user clicked the button, so the focus is not in the box.
    starter("Build a checklist").focus();

    fireEvent.click(starter("Build a checklist"));

    expect(composer().value).toBe(CHECKLIST_DRAFT);
    expect(document.activeElement).toBe(composer());
    const shown = notice()!;
    expect(shown.textContent).toContain("Starter draft: Build a checklist");
    expect(shown.textContent).toContain("The app put starter text in the message box. Review it before sending.");
    // The text is fixed text of the app. No tool view or generated view wrote it, and nothing in it needs a warning.
    expect(shown.textContent).not.toMatch(/tool view|generated view/i);
    expect(within(shown).queryByRole("alert")).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    await settle();
    expect(messagePosts()).toBe(0);
    expect(server.openStreams("messages:s-1")).toHaveLength(0);
  });

  it("sends exactly the text that the user changed, with the normal Send, and the starters do not come back", async () => {
    await openEmptyChat();
    fireEvent.click(starter("Compare options"));
    expect(messagePosts()).toBe(0);

    const edited = "Help me compare Postgres and MySQL in a table. First ask me which criteria matter to me.";
    fireEvent.change(composer(), { target: { value: edited } });
    expect(notice()).not.toBeNull();
    server.messageReplies = [(stream) => {
      stream.push(ev.runStarted("a1"), ev.userPersisted("u1", edited), ev.textStart("r-1"), ev.text("r-1", "Which criteria matter?"), ev.textEnd("r-1"), ev.runFinished("a1"));
      stream.finish();
    }];
    await act(async () => { fireEvent.click(screen.getByTestId("copilot-send-button")); });

    await screen.findByText("Which criteria matter?");
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]).toMatchObject({ sessionId: "s-1", text: edited });
    expect(composer().value).toBe("");
    expect(notice()).toBeNull();
    // The chat has messages now. An empty box does not bring the starters back.
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
  });

  it.each(CHAT_STARTERS.map((entry) => [entry.label, entry] as const))(
    "%s: the draft asks the agent for what is missing and names no tool, file, or result",
    async (label, entry) => {
      await openEmptyChat();
      fireEvent.click(starter(label));

      const text = composer().value;
      expect(text).toBe(entry.draft);
      expect(text).toMatch(/\bask me\b/i);
      expect(text).toMatch(/\bdo not invent\b/i);
      // Plain language: no markup, no braces, no tool or API names, no claim of finished work.
      expect(text).not.toMatch(/[`{}<>[\]]|render_ui|a2ui|Checklist\b.*component|ComparisonTable|StatusSummary|\bhttps?:|\.(csv|xlsx|pdf|docx)\b/);
      expect(text).not.toMatch(/\b(attached|my file|the file|connected|I have already|here is)\b/i);
      expect(within(notice()!).queryByRole("alert")).toBeNull();
      expect(messagePosts()).toBe(0);
    }
  );

  it("does not replace text that the user typed, and shows the starters again when the box is empty", async () => {
    await openEmptyChat();

    fireEvent.change(composer(), { target: { value: "My own question" } });

    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
    expect(screen.getByText("Ask me anything.")).toBeTruthy();
    expect(composer().value).toBe("My own question");
    expect(notice()).toBeNull();

    fireEvent.change(composer(), { target: { value: "" } });

    expect(screen.getByText(HEADING)).toBeTruthy();
    expect(starterButtons()).toHaveLength(4);
    expect(composer().value).toBe("");
    expect(messagePosts()).toBe(0);
  });

  it("shows the starters again after the user clears the draft", async () => {
    await openEmptyChat();
    fireEvent.click(starter("Summarize status"));
    expect(screen.queryByText(HEADING)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));

    expect(composer().value).toBe("");
    expect(notice()).toBeNull();
    expect(screen.getByText(HEADING)).toBeTruthy();
    expect(messagePosts()).toBe(0);
  });

  it("holds a second click in the same frame to the first draft, because the seam sees the text at once", async () => {
    await openEmptyChat();
    const first = starter("Build a checklist");
    const second = starter("Use the side panel");

    // Both clicks reach the host before it renders again, so the list is still on screen for the second one.
    await act(async () => {
      fireEvent.click(first);
      fireEvent.click(second);
    });

    expect(composer().value).toBe(CHECKLIST_DRAFT);
    expect(notice()!.textContent).toContain("Starter draft: Build a checklist");
    expect(messagePosts()).toBe(0);
  });

  it("keeps text that the user typed before the history arrived, and shows no starters", async () => {
    let held!: FixtureStream;
    server.connect("s-1", (stream) => { held = stream; });
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");
    // The history has not arrived. The chat does not show an empty chat yet.
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByText("Ask me anything.")).toBeNull();
    fireEvent.change(composer(), { target: { value: "Typed while loading" } });

    await act(async () => {
      held.push(...ev.history({ messages: [] }));
      held.finish();
    });

    await screen.findByText("Ask me anything.");
    expect(starterButtons()).toEqual([]);
    expect(composer().value).toBe("Typed while loading");
    expect(messagePosts()).toBe(0);
  });
});

describe("when the chat offers no starters", () => {
  it("shows none while the history loads, and shows them when it arrives", async () => {
    let held!: FixtureStream;
    server.connect("s-1", (stream) => { held = stream; });
    render(hostElement());
    await screen.findByTestId("copilot-chat-textarea");
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);

    await act(async () => {
      held.push(...ev.history({ messages: [] }));
      held.finish();
    });

    await screen.findByText(HEADING);
    expect(messagePosts()).toBe(0);
  });

  it("shows none in a chat that has messages", async () => {
    server.connect("s-1", idleHistory(EARLIER));
    render(hostElement());

    await screen.findByText("Earlier answer");
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByText("Ask me anything.")).toBeNull();
    expect(starterButtons()).toEqual([]);
  });

  it("shows none to a reader of a shared chat, who has no message box", async () => {
    server.connect("s-1", idleHistory([]));
    render(hostElement({ canEdit: false }));

    await screen.findByText("No messages in this chat yet.");
    expect(screen.getByRole("note").textContent).toContain("only project owners and editors can send messages");
    expect(screen.queryByTestId("copilot-chat-textarea")).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
  });

  it("shows none while a turn runs on the server, and does not offer one when it ends with the chat still empty", async () => {
    server.running.set("s-1", true);
    server.connect("s-1", (stream) => {
      stream.push(...ev.history({ messages: [], activeTurn: "unavailable" }));
      stream.finish();
    });
    render(hostElement({ isRunning: true }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("The agent is still working on this chat"));
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
    expect(messagePosts()).toBe(0);
  });

  it("shows none while this tab streams a turn that has no message yet", async () => {
    server.running.set("s-1", true);
    server.connect("s-1", (stream) => {
      stream.push(...ev.history({ messages: [], activeTurn: "attached" }), ev.runStarted("a1"), ev.turnStarted("a1"));
    });
    render(hostElement({ isRunning: true }));

    // While this tab streams a turn, the send button is the Stop button.
    await screen.findByRole("button", { name: "Stop" });
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
    expect(messagePosts()).toBe(0);
  });

  it("shows none when the server refused the connection", async () => {
    server.connect("s-1", { status: 403, body: { error: "forbidden" } });
    render(hostElement());

    await screen.findByText("This chat did not load");
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
    expect(messagePosts()).toBe(0);
  });

  it("shows none while the chat streams a reply, and none after it", async () => {
    await openEmptyChat();
    let reply!: FixtureStream;
    server.messageReplies = [(stream) => { reply = stream; }];
    fireEvent.change(composer(), { target: { value: "First question" } });
    await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
    await waitFor(() => expect(server.sent).toHaveLength(1));

    expect(screen.queryByText(HEADING)).toBeNull();
    expect(starterButtons()).toEqual([]);
    await act(async () => {
      reply.push(ev.runStarted("a1"), ev.textStart("r-1"), ev.text("r-1", "First answer"), ev.textEnd("r-1"), ev.runFinished("a1"));
      reply.finish();
    });
    await screen.findByText("First answer");
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(server.sent).toHaveLength(1);
  });

  it("shows none, ever, for a chat that starts a project prompt, and sends the prompt once", async () => {
    let held!: FixtureStream;
    server.connect("s-1", (stream) => { held = stream; });
    let reply!: FixtureStream;
    server.messageReplies = [(stream) => { reply = stream; }];
    // Record each time that the heading enters the page, also when the next
    // render takes it out again. A check after the fact could miss a flash.
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.textContent?.includes(HEADING)) seen.push(HEADING);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      render(hostElement({ initialPrompt: "Resolve the draft" }));
      await screen.findByTestId("copilot-chat-textarea");

      await act(async () => {
        held.push(...ev.history({ messages: [] }));
        held.finish();
      });

      await waitFor(() => expect(server.sent).toHaveLength(1));
      expect(server.sent[0]).toMatchObject({ sessionId: "s-1", text: "Resolve the draft" });
      await act(async () => {
        reply.push(ev.runStarted("a1"), ev.runFinished("a1"));
        reply.finish();
      });
      await settle();
      expect(seen).toEqual([]);
      expect(starterButtons()).toEqual([]);
      expect(server.sent).toHaveLength(1);
    } finally {
      observer.disconnect();
    }
  });
});

describe("a switch to another chat", () => {
  it("leaves the draft of the first chat behind, and offers the starters in an empty second chat", async () => {
    server.connect("s-1", idleHistory([]));
    server.connect("s-2", idleHistory([], { threadId: "s-2" }));
    const view = render(hostElement({ id: "s-1" }));
    await screen.findByText(HEADING);
    fireEvent.click(starter("Build a checklist"));
    expect(composer().value).toBe(CHECKLIST_DRAFT);
    expect(notice()).not.toBeNull();

    view.rerender(hostElement({ id: "s-2" }));

    await screen.findByText(HEADING);
    expect(composer().value).toBe("");
    expect(notice()).toBeNull();
    expect(starterButtons()).toHaveLength(4);
    expect(messagePosts()).toBe(0);
  });

  it("offers none in a second chat that has messages, and a draft of the first chat does not reach it", async () => {
    server.connect("s-1", idleHistory([]));
    server.connect("s-2", idleHistory(EARLIER.map((message) => ({ ...message, id: `${message.id}-2` })), { threadId: "s-2" }));
    const view = render(hostElement({ id: "s-1" }));
    await screen.findByText(HEADING);
    fireEvent.click(starter("Compare options"));

    view.rerender(hostElement({ id: "s-2" }));

    await screen.findByText("Earlier answer");
    await settle();
    expect(composer().value).toBe("");
    expect(notice()).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(messagePosts()).toBe(0);
  });
});
