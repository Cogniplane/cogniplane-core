// @vitest-environment jsdom
// The actual SDK input, chat host, browser agent and storage run here. HTTP
// fixtures replace the backend; no provider or model is called.
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));
import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { CopilotChatHost } from "./copilot-chat-host";
import { clearComposerDrafts, COMPOSER_DRAFT_MAX_AGE_MS, COMPOSER_DRAFT_MAX_CHARS, COMPOSER_DRAFT_STORAGE_KEY } from "./composer-drafts.logic";
import type { DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();
const OWNER = { userId: "u-1", tenantId: "t-1" };
let server: FixtureServer;
beforeEach(() => {
  window.sessionStorage.clear();
  server = new FixtureServer();
  for (const id of ["s-1", "s-2"]) server.connect(id, idleHistory([], { threadId: id }));
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });
const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
function host(id = "s-1", scope: DraftScope | undefined = OWNER) {
  return <CopilotChatHost session={{ id, initialToolStatuses: [], initialApprovals: [] }}
    modelSelection={{ model: "model-1", effort: null, models: [], showEffortSelector: false, onModelChange() {}, onEffortChange() {} }}
    usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }} artifactIds={[]} events={{}} draftScope={scope} />;
}
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const ready = () => screen.findByText("Start with a draft");
const sent = () => act(async () => { fireEvent.click(screen.getByTestId("copilot-send-button")); });
const stored = () => window.sessionStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
async function reload(id = "s-1") {
  cleanup();
  render(host(id));
  await waitFor(() => expect(composer()).toBeTruthy());
}

describe("unsent composer recovery", () => {
  it("recovers exact ordinary text after leaving for Projects, returning and reloading, without sending", async () => {
    const view = render(<StrictMode>{host()}</StrictMode>);
    await ready();
    const text = "  Unsent words\nwith another line  ";
    type(text);
    // The Projects route unmounts the chat host. Back to chat mounts a new one.
    view.rerender(<div>Projects</div>);
    expect(stored()).toContain("Unsent words");
    view.rerender(host());
    await waitFor(() => expect(composer().value).toBe(text));
    await reload();
    expect(composer().value).toBe(text);
    expect(server.sent).toEqual([]);
  });

  it("recovers an edited starter with its explanation, then keeps Clear draft and focus", async () => {
    render(host()); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Build a checklist" }));
    expect(document.activeElement).toBe(composer());
    type(`${composer().value}\nMy own extra step`);
    const text = composer().value;
    await reload();
    expect(composer().value).toBe(text);
    expect(screen.getByRole("group", { name: "Starter draft" }).textContent).toContain("The app put starter text");
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    expect(document.activeElement).toBe(composer());
    await reload();
    expect(composer().value).toBe("");
    expect(screen.queryByRole("group", { name: "Starter draft" })).toBeNull();
  });

  it("keeps separate session drafts even if a host changes session without a key", async () => {
    const view = render(host()); await ready(); type("Session one");
    view.rerender(host("s-2")); await ready(); expect(composer().value).toBe(""); type("Session two");
    view.rerender(host()); await waitFor(() => expect(composer().value).toBe("Session one"));
    view.rerender(host("s-2")); await waitFor(() => expect(composer().value).toBe("Session two"));
  });

  it.each([false, true])("does not extend retention when opening an existing draft, starter %s", async (starter) => {
    render(<StrictMode>{host()}</StrictMode>); await ready();
    if (starter) fireEvent.click(screen.getByRole("button", { name: "Build a checklist" }));
    else type("Existing draft");
    const data = JSON.parse(stored()!);
    const editedAt = Date.now() - 60 * 60 * 1000;
    data.sessions["s-1"].at = editedAt;
    window.sessionStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(data));
    cleanup();
    render(<StrictMode>{host()}</StrictMode>);
    await waitFor(() => expect(composer().value).toBe(data.sessions["s-1"].text));
    if (starter) expect(screen.getByRole("group", { name: "Starter draft" })).toBeTruthy();
    expect(JSON.parse(stored()!).sessions["s-1"].at).toBe(editedAt);
    expect(server.sent).toEqual([]);
  });

  it.each([{ userId: "other", tenantId: OWNER.tenantId }, { userId: OWNER.userId, tenantId: "other" }])(
    "never exposes the old draft after an identity change to %j", async (scope) => {
      const view = render(host()); await ready(); type("Private draft");
      view.rerender(host("s-1", scope)); await ready(); expect(composer().value).toBe("");
      type("New owner draft");
      view.rerender(host()); await ready(); expect(composer().value).toBe("");
    }
  );

  it("does not persist without an identity and does not flush old text after logout cleanup", async () => {
    const view = render(host()); await ready(); type("Before logout");
    act(() => { clearComposerDrafts(); });
    type("Stale component event");
    expect(stored()).toBeNull();
    view.unmount();
    render(<CopilotChatHost session={{ id: "s-1", initialToolStatuses: [], initialApprovals: [] }}
      modelSelection={{ model: "model-1", effort: null, models: [], showEffortSelector: false, onModelChange() {}, onEffortChange() {} }}
      usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }} artifactIds={[]} events={{}} />);
    await ready(); type("No identity"); expect(stored()).toBeNull();
  });

  it("leaves text editable when storage is blocked and does not recover an old copy after a write fails", async () => {
    render(host()); await ready(); type("Old draft");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    type("Latest draft"); expect(composer().value).toBe("Latest draft");
    expect(screen.getByText(/This tab could not save your message draft/)).toBeTruthy();
    set.mockRestore(); await reload(); expect(composer().value).toBe("");
    cleanup();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    render(host()); await ready(); type("Still editable"); expect(composer().value).toBe("Still editable");
  });

  it("drops corrupt, expired and oversized drafts without truncating the active text", async () => {
    window.sessionStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, "broken json");
    render(host()); await ready(); expect(composer().value).toBe("");
    type("Expires");
    const data = JSON.parse(stored()!); data.sessions["s-1"].at = Date.now() - COMPOSER_DRAFT_MAX_AGE_MS - 1;
    window.sessionStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(data));
    await reload(); expect(composer().value).toBe("");
    type("x".repeat(COMPOSER_DRAFT_MAX_CHARS + 1));
    expect(composer().value).toHaveLength(COMPOSER_DRAFT_MAX_CHARS + 1);
    expect(screen.getByText(/This tab could not save your message draft/)).toBeTruthy();
    await reload(); expect(composer().value).toBe("");
  });

  it.each([400, 429, 500])("preserves a rejected send with HTTP %s through reload", async (status) => {
    render(host()); await ready(); type("Do not lose this");
    server.messageReplies = [{ status, body: { error: status === 429 ? "session_busy" : "rejected" } }];
    await sent(); await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(composer().value).toBe("Do not lose this");
    if (status < 500) {
      await waitFor(() => expect(JSON.parse(stored()!).sessions["s-1"].pending).toBeUndefined());
      expect(screen.queryByText(/This draft may already have been sent/)).toBeNull();
    } else {
      await screen.findByText(/This draft may already have been sent/);
    }
    await reload(); expect(composer().value).toBe("Do not lose this");
  });

  it("clears only after a persisted prompt, and never restores a submitted message", async () => {
    let stream!: FixtureStream;
    server.messageReplies = [(next) => { stream = next; }];
    render(host()); await ready(); type("Send me"); await sent();
    await waitFor(() => expect(stream).toBeTruthy());
    expect(composer().value).toBe("Send me");
    await act(async () => { stream.push(ev.runStarted("run"), ev.userPersisted("saved", "Send me")); });
    await waitFor(() => expect(composer().value).toBe(""));
    await reload(); expect(composer().value).toBe(""); expect(stored()).toBeNull();
  });

  it("submits once for two Enter presses before the SDK starts a run, then permits another send", async () => {
    let stream!: FixtureStream;
    server.messageReplies = [(next) => { stream = next; }];
    render(host()); await ready(); type("Only once");
    act(() => {
      fireEvent.keyDown(composer(), { key: "Enter" });
      fireEvent.keyDown(composer(), { key: "Enter" });
    });
    await waitFor(() => expect(stream).toBeTruthy());
    expect(server.sent).toHaveLength(1);
    await act(async () => {
      stream.push(ev.runStarted("run"), ev.userPersisted("saved", "Only once"), ev.runFinished("run"));
      stream.finish();
    });
    await waitFor(() => expect(screen.getByTestId("copilot-send-button")).toBeTruthy());
    expect(server.sent).toHaveLength(1);
    expect(screen.queryByText(/This draft may already have been sent/)).toBeNull();
    type("Next message");
    await sent();
    await waitFor(() => expect(server.sent).toHaveLength(2));
  });

  it.each(["New draft", "Send me", ""])("preserves user edits made during send, including identical replacement %s", async (replacement) => {
    let stream!: FixtureStream;
    server.messageReplies = [(next) => { stream = next; }];
    render(host()); await ready(); type("Send me"); await sent();
    await waitFor(() => expect(stream).toBeTruthy());
    type(""); type(replacement);
    await act(async () => { stream.push(ev.runStarted("run"), ev.userPersisted("saved", "Send me")); });
    expect(composer().value).toBe(replacement);
    await reload(); expect(composer().value).toBe(replacement);
  });

  it("keeps new edits when the saved history arrives after mount", async () => {
    server.messageReplies = [() => {}];
    render(host()); await ready(); type("Submitted"); await sent();
    await waitFor(() => expect(server.sent).toHaveLength(1));
    cleanup();
    let history!: FixtureStream;
    server.connect("s-1", (stream) => { history = stream; });
    render(host());
    expect(composer().value).toBe("Submitted");
    type("New draft while history loads");
    await waitFor(() => expect(history).toBeTruthy());
    await act(async () => {
      history.push(...ev.history({ messages: [{ id: "saved", role: "user", content: "Submitted" }] }));
      history.finish();
    });
    expect(composer().value).toBe("New draft while history loads");
    await reload(); expect(composer().value).toBe("New draft while history loads");
  });

  it("does not clear a rejected draft when someone later submits the same text", async () => {
    server.messageReplies = [{ status: 400, body: { error: "rejected" } }];
    render(host()); await ready(); type("Same words"); await sent();
    await waitFor(() => expect(JSON.parse(stored()!).sessions["s-1"].pending).toBeUndefined());
    server.connect("s-1", idleHistory([{ id: "someone-else", role: "user", content: "Same words" }]));
    await reload(); expect(composer().value).toBe("Same words");
  });

  it("bounds recovery to the eight most recently edited sessions", async () => {
    const view = render(host()); await ready(); type("Oldest");
    for (let index = 2; index <= 9; index++) {
      const id = `s-${index}`;
      server.connect(id, idleHistory([], { threadId: id }));
      view.rerender(host(id)); await ready(); type(`Draft ${index}`);
    }
    expect(Object.keys(JSON.parse(stored()!).sessions)).toHaveLength(8);
    view.rerender(host()); await ready(); expect(composer().value).toBe("");
    view.rerender(host("s-9")); await waitFor(() => expect(composer().value).toBe("Draft 9"));
  });

  it.each(["Same words", "Redacted text"])("keeps an unconfirmed send after reload despite matching or rewritten history: %s", async (savedText) => {
    const earlier = { id: "old", role: "user", content: "Same words" };
    server.connect("s-1", idleHistory([earlier]));
    server.messageReplies = [() => {}];
    render(host()); await screen.findByText("Same words"); type("Same words"); await sent();
    await waitFor(() => expect(server.sent).toHaveLength(1));
    await reload(); expect(composer().value).toBe("Same words");
    expect(screen.getByText(/This draft may already have been sent/)).toBeTruthy();
    server.connect("s-1", idleHistory([earlier, { id: "new", role: "user", content: savedText }]));
    await reload(); expect(composer().value).toBe("Same words");
    expect(server.sent).toHaveLength(1);
  });

  it("does not treat a reconnect replay as acknowledgement of this tab's attempt", async () => {
    server.messageReplies = [() => {}];
    render(host()); await ready(); type("Unconfirmed"); await sent();
    await waitFor(() => expect(server.sent).toHaveLength(1));
    server.connect("s-1", (stream) => {
      const history = ev.history({ messages: [] });
      stream.push(...history.slice(0, -1), ev.userPersisted("saved", "Unconfirmed"), history.at(-1)!);
      stream.finish();
    });
    await reload();
    expect(composer().value).toBe("Unconfirmed");
    expect(screen.getByText(/This draft may already have been sent/)).toBeTruthy();
    expect(server.sent).toHaveLength(1);
  });

  it("keeps the draft and explains uncertainty when fetch rejects", async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/messages")) return Promise.reject(new TypeError("Failed to fetch"));
      return server.fetch(input, init);
    });
    vi.stubGlobal("fetch", fetch);
    render(host()); await ready(); type("Network failure draft"); await sent();
    await screen.findByText(/This draft may already have been sent/);
    expect(composer().value).toBe("Network failure draft");
    await reload(); expect(composer().value).toBe("Network failure draft");
  });

  it.each([false, true])("warns when a send closes without acknowledgment, terminal event %s", async (terminal) => {
    const text = "Unconfirmed after clean close";
    server.connect("s-1", idleHistory([]), idleHistory([{ id: "saved-before-close", role: "user", content: text }]));
    server.messageReplies = [(stream) => {
      stream.push(ev.runStarted("run"));
      if (terminal) stream.push(ev.runFinished("run"));
      stream.finish();
    }];
    render(host()); await ready(); type(text); await sent();
    await screen.findByText(/This draft may already have been sent/);
    await waitFor(() => expect(screen.getByTestId("copilot-send-button")).toBeTruthy());
    expect(composer().value).toBe(text);
    expect(server.sent).toHaveLength(1);
    await reload();
    expect(composer().value).toBe(text);
    expect(screen.getByText(/This draft may already have been sent/)).toBeTruthy();
    expect(server.sent).toHaveLength(1);
  });

  it.each(["New draft", "Submitted", ""])("keeps edits without a delivery warning after a clean close: %s", async (replacement) => {
    let stream!: FixtureStream;
    server.messageReplies = [(next) => { stream = next; }];
    render(host()); await ready(); type("Submitted"); await sent();
    await waitFor(() => expect(stream).toBeTruthy());
    type(""); type(replacement);
    await act(async () => { stream.push(ev.runStarted("run")); stream.finish(); });
    await waitFor(() => expect(screen.getByTestId("copilot-send-button")).toBeTruthy());
    expect(composer().value).toBe(replacement);
    expect(screen.queryByText(/This draft may already have been sent/)).toBeNull();
    await reload(); expect(composer().value).toBe(replacement);
    expect(screen.queryByText(/This draft may already have been sent/)).toBeNull();
    expect(server.sent).toHaveLength(1);
  });
});
