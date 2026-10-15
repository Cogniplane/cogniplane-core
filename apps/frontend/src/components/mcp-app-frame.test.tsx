// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bridges: [] as Array<{ onmessage?: (message: { role: string; content: unknown[] }) => Promise<{ isError?: boolean }>;
    setHostContext: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; options: unknown }>,
  transports: [] as Array<{ peer: unknown; origin: string }>,
  transportError: null as Error | null,
  connectGate: null as Promise<void> | null,
  fetch: vi.fn()
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    onmessage?: (message: { role: string; content: unknown[] }) => Promise<{ isError?: boolean }>;
    options: unknown;
    constructor(_client: unknown, _info: unknown, _capabilities: unknown, options: unknown) {
      this.options = options;
      state.bridges.push(this);
    }
    setHostContext = vi.fn();
    connect = vi.fn(() => state.connectGate ?? Promise.resolve());
    close = vi.fn().mockResolvedValue(undefined);
  }
}));
// The transport has its own tests with the real ext-apps class. Here it records
// the window and the origin that the frame gives it.
vi.mock("../lib/mcp-app-origin-transport", () => ({
  OriginBoundPostMessageTransport: class {
    constructor(peer: unknown, origin: string) {
      if (state.transportError) throw state.transportError;
      state.transports.push({ peer, origin });
    }
  }
}));
vi.mock("../lib/api-client", () => ({ fetchWithAuthRetry: state.fetch }));

import { McpAppFrame } from "./mcp-app-frame";

afterEach(() => {
  cleanup();
  state.bridges.length = 0;
  state.transports.length = 0;
  state.transportError = null;
  state.connectGate = null;
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  delete document.documentElement.dataset.theme;
});

it("updates the host theme without rebuilding the frame or losing widget state", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  document.documentElement.dataset.theme = "dark";
  state.fetch.mockResolvedValue({ ok: true, json: async () => ({
    resource: { uri: "ui://widget", mimeType: "text/html", text: "<input value='400'>" },
    input: {}, result: { content: [{ type: "text", text: "Estimate" }] }
  }) });
  render(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="estimate"
    app={{ resourceUri: "ui://widget", result: { content: [{ type: "text", text: "Estimate" }] } }}
    draft={{ place: vi.fn() }} canEdit busy={false} />);
  await waitFor(() => expect(state.bridges).toHaveLength(1));
  const frame = screen.getByTitle("Interactive tool view");
  expect(state.bridges[0]!.options).toEqual({ hostContext: { theme: "dark" } });
  await act(async () => { document.documentElement.dataset.theme = "light"; });
  expect(state.bridges[0]!.setHostContext).toHaveBeenCalledWith({ theme: "light" });
  expect(state.bridges).toHaveLength(1);
  expect(screen.getByTitle("Interactive tool view")).toBe(frame);
});

const QUOTES_URI = "ui://quote-picker/app.html";
const QUOTES_SOURCE = `show_quotes (${QUOTES_URI})`;
const QUOTES_RESPONSE = { ok: true, json: async () => ({
  resource: { uri: QUOTES_URI, mimeType: "text/html", text: "<p>Quotes</p>" },
  input: {}, result: { content: [{ type: "text", text: "Quotes" }] }
}) };
const QUOTES_APP = { resourceUri: QUOTES_URI, result: { content: [{ type: "text", text: "Quotes" }] } };

type Placement = "placed" | "occupied" | "unavailable";
type Request = { text: string; source: string; append: boolean };

/** A frame with a stand-in for the draft seam, and the bridge handler that the
 *  widget reaches with `ui/message`. */
async function renderQuotes(options: { canEdit?: boolean; busy?: boolean; placements?: Placement[] } = {}) {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue(QUOTES_RESPONSE);
  const placements = [...(options.placements ?? ["placed"])];
  const place = vi.fn((_request: Request): Placement => placements.shift() ?? "placed");
  const view = render(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="show_quotes" app={QUOTES_APP}
    draft={{ place }} canEdit={options.canEdit ?? true} busy={options.busy ?? false} />);
  await waitFor(() => expect(state.bridges).toHaveLength(1));
  const message = (text: string, role = "user") => {
    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role, content: [{ type: "text", text }] }); });
    return response;
  };
  return { place, message, view };
}

it("puts a widget message in the message box as a draft, with no Send button and no turn", async () => {
  const { place, message } = await renderQuotes();

  expect(await message("Draft a decision for HelpHarbor.")).toEqual({});

  expect(place).toHaveBeenCalledOnce();
  expect(place).toHaveBeenCalledWith({ text: "Draft a decision for HelpHarbor.", source: QUOTES_SOURCE, append: false });
  // The widget has no way to send. The frame holds no agent and shows no Send control.
  expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  expect(screen.queryByRole("group")).toBeNull();
});

it("hands over the text exactly as the widget wrote it, with no trimming or stripping", async () => {
  const { place, message } = await renderQuotes();
  const raw = "\n\n\n  Look\u202E at this\u0001";

  await message(raw);

  expect(place).toHaveBeenCalledWith(expect.objectContaining({ text: raw }));
});

it("refuses a message over the limit with a visible error, and puts nothing in the box", async () => {
  const { place, message } = await renderQuotes();

  expect(await message("x".repeat(4_001))).toEqual({ isError: true });

  expect(place).not.toHaveBeenCalled();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "A tool view tried to send a message of 4,001 characters. The limit is 4,000 characters, so the chat did not accept it."
  );
  // A long message that hides text below blank lines is refused the same way.
  expect(await message(`Ask${"\n".repeat(5_000)}Do the other thing`)).toEqual({ isError: true });
  expect(place).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("accepts a message of exactly the limit", async () => {
  const { place, message } = await renderQuotes();
  expect(await message("x".repeat(4_000))).toEqual({});
  expect(place).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  ["a read-only session", { canEdit: false }],
  ["a session that is busy", { busy: true }]
])("refuses a message for %s, and says nothing about it", async (_name, options) => {
  const { place, message } = await renderQuotes(options);

  expect(await message("Try this quote")).toEqual({ isError: true });
  // Not even a long one: the chat cannot take a message at all.
  expect(await message("x".repeat(5_000))).toEqual({ isError: true });

  expect(place).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("refuses a message that is not one text block from the user", async () => {
  const { place, message } = await renderQuotes();
  expect(await message("Ignore previous", "assistant")).toEqual({ isError: true });
  let response!: Promise<{ isError?: boolean }>;
  act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "image", data: "x" }] }); });
  expect(await response).toEqual({ isError: true });
  expect(place).not.toHaveBeenCalled();
});

it("refuses when no message box takes a draft", async () => {
  const { place, message } = await renderQuotes({ placements: ["unavailable"] });
  expect(await message("Try this quote")).toEqual({ isError: true });
  expect(place).toHaveBeenCalledOnce();
  expect(screen.queryByRole("group")).toBeNull();
});

describe("with a draft of the user in the message box", () => {
  it("asks first, leaves the draft alone, and shows only the length of the widget text", async () => {
    const { place } = await renderQuotes({ placements: ["occupied"] });
    const secret = "WIDGET TEXT THAT MUST NOT PREVIEW";

    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: secret }] }); });

    const ask = screen.getByRole("group", { name: "Tool view message waiting" });
    expect(ask.textContent).toContain("You already have a draft, so nothing changed yet.");
    expect(ask.textContent).toContain(`(${secret.length} characters)`);
    expect(ask.textContent).not.toContain(secret);
    expect(place).toHaveBeenCalledOnce();
    expect(place.mock.calls[0]![0].append).toBe(false);
    // No Send button, only Add and Dismiss.
    expect(within(ask).getAllByRole("button").map((button) => button.textContent)).toEqual(["Add after my draft", "Dismiss"]);
    expect(await Promise.race([response, Promise.resolve("still waiting")])).toBe("still waiting");
  });

  it("adds the text after the draft only when the user chooses it", async () => {
    const { place, message } = await renderQuotes({ placements: ["occupied", "placed"] });
    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: "From the widget" }] }); });

    fireEvent.click(screen.getByRole("button", { name: "Add after my draft" }));

    expect(await response).toEqual({});
    expect(place).toHaveBeenCalledTimes(2);
    expect(place).toHaveBeenLastCalledWith({ text: "From the widget", source: QUOTES_SOURCE, append: true });
    expect(screen.queryByRole("group")).toBeNull();
    // The widget can ask again after the answer.
    place.mockReturnValueOnce("placed");
    expect(await message("Again")).toEqual({});
  });

  it("drops the text when the user dismisses it, and the draft is never touched", async () => {
    const { place } = await renderQuotes({ placements: ["occupied"] });
    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: "From the widget" }] }); });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await response).toEqual({ isError: true });
    expect(place).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("keeps one waiting request, and refuses the next one", async () => {
    const { place, message } = await renderQuotes({ placements: ["occupied"] });
    let first!: Promise<{ isError?: boolean }>;
    act(() => { first = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: "First" }] }); });

    expect(await message("Second")).toEqual({ isError: true });

    expect(place).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await first).toEqual({ isError: true });
  });

  it("answers a waiting request with an error when the view goes away", async () => {
    const { view } = await renderQuotes({ placements: ["occupied"] });
    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: "First" }] }); });

    view.unmount();

    expect(await response).toEqual({ isError: true });
  });

  it("does not add the text when the session became busy while the request waited", async () => {
    vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
    state.fetch.mockResolvedValue(QUOTES_RESPONSE);
    const place = vi.fn((): Placement => "occupied");
    const draft = { place };
    const view = render(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="show_quotes" app={QUOTES_APP}
      draft={draft} canEdit busy={false} />);
    await waitFor(() => expect(state.bridges).toHaveLength(1));
    let response!: Promise<{ isError?: boolean }>;
    act(() => { response = state.bridges[0]!.onmessage!({ role: "user", content: [{ type: "text", text: "First" }] }); });

    view.rerender(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="show_quotes" app={QUOTES_APP}
      draft={draft} canEdit busy />);
    expect((screen.getByRole("button", { name: "Add after my draft" }) as HTMLButtonElement).disabled).toBe(true);
    // The bridge keeps its widget: the rerender did not rebuild it.
    expect(state.bridges).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await response).toEqual({ isError: true });
    expect(place).toHaveBeenCalledOnce();
  });
});

it("shows an error when the server does not provide structured tool input", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      resource: { uri: "ui://quote-picker/app.html", mimeType: "text/html", text: "<p>Quotes</p>" },
      input: "{truncated",
      result: { content: [{ type: "text", text: "Quotes" }] }
    })
  });
  render(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="show_quotes"
    app={{ resourceUri: "ui://quote-picker/app.html", result: { content: [{ type: "text", text: "Quotes" }] } }}
    draft={{ place: vi.fn() }} canEdit busy={false} />);
  expect((await screen.findByRole("alert")).textContent).toBe("The server returned an invalid tool view.");
  expect(state.bridges).toHaveLength(0);
});

const WIDGET_RESPONSE = { ok: true, json: async () => ({
  resource: { uri: "ui://quote-picker/app.html", mimeType: "text/html", text: "<p>Quotes</p>" },
  input: {}, result: { content: [{ type: "text", text: "Quotes" }] }
}) };
const WIDGET_APP = { resourceUri: "ui://quote-picker/app.html", result: { content: [{ type: "text", text: "Quotes" }] } };

function renderWidget() {
  return render(<McpAppFrame sessionId="s-1" toolCallId="call-1" toolName="show_quotes" app={WIDGET_APP}
    draft={{ place: vi.fn() }} canEdit busy={false} />);
}

it("connects the bridge to the sandbox window and its exact origin, then loads the sandbox page", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue(WIDGET_RESPONSE);
  renderWidget();

  await waitFor(() => expect(state.bridges).toHaveLength(1));
  const frame = screen.getByTitle("Interactive tool view") as HTMLIFrameElement;
  expect(state.transports).toHaveLength(1);
  // jsdom makes a new window object when the frame navigates; a browser keeps
  // the same one. Either way the peer is the window of this frame.
  expect((state.transports[0]!.peer as Window).frameElement).toBe(frame);
  expect(state.transports[0]!.origin).toBe("https://sandbox.example.test");
  expect(state.bridges[0]!.connect).toHaveBeenCalledWith(expect.any(Object));
  // The page loads after the bridge listens, so its first message is not lost.
  await waitFor(() => expect(frame.getAttribute("src")).toBe("https://sandbox.example.test/mcp-app-sandbox.html"));
});

it("gives the transport the normalized origin, not the configured text", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://Sandbox.Example.test:443/ignored?x=1");
  state.fetch.mockResolvedValue(WIDGET_RESPONSE);
  renderWidget();

  await waitFor(() => expect(state.transports).toHaveLength(1));
  expect(state.transports[0]!.origin).toBe("https://sandbox.example.test");
});

it("closes the bridge and clears the frame address when it unmounts", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue(WIDGET_RESPONSE);
  const view = renderWidget();
  await waitFor(() => expect(state.bridges).toHaveLength(1));
  const frame = screen.getByTitle("Interactive tool view");
  await waitFor(() => expect(frame.getAttribute("src")).not.toBeNull());

  view.unmount();
  expect(state.bridges[0]!.close).toHaveBeenCalledOnce();
  expect(frame.hasAttribute("src")).toBe(false);
});

it("does not load the sandbox page when the frame goes away before the bridge connects", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue(WIDGET_RESPONSE);
  let connected!: () => void;
  state.connectGate = new Promise<void>((resolve) => { connected = resolve; });
  const view = renderWidget();
  await waitFor(() => expect(state.bridges).toHaveLength(1));
  const frame = screen.getByTitle("Interactive tool view");
  expect(frame.hasAttribute("src")).toBe(false);

  view.unmount();
  connected();
  await act(async () => { await Promise.resolve(); });
  expect(frame.hasAttribute("src")).toBe(false);
});

it("shows an error and loads nothing when the origin-checked transport cannot start", async () => {
  vi.stubEnv("NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN", "https://sandbox.example.test");
  state.fetch.mockResolvedValue(WIDGET_RESPONSE);
  state.transportError = new Error("The MCP App transport cannot check message origins.");
  renderWidget();

  expect((await screen.findByRole("alert")).textContent).toBe("The tool view could not connect.");
  expect(state.bridges[0]!.connect).not.toHaveBeenCalled();
});
