// @vitest-environment jsdom
//
// The development Inspector of the chat host: the real CopilotKit provider and
// CopilotChat, the real DeepAgentsBrowserAgent, and the real pinned
// @copilotkit/web-inspector element, which jsdom mounts with its shadow DOM.
// The network is a fixture. A spy wraps configureWebInspectorElement and
// calls the real function, and the module factory records that the package
// loaded. The tests that expect no Inspector run first, before any test loads
// the package.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inspectorPackage = vi.hoisted(() => {
  // The app does not depend on @copilotkit/web-inspector. CopilotKit loads
  // its own copy beside react-core, and the mock must name that file.
  const { createRequire } = process.getBuiltinModule("node:module");
  const { realpathSync } = process.getBuiltinModule("node:fs");
  const { dirname, join } = process.getBuiltinModule("node:path");
  const reactCore = realpathSync(createRequire(import.meta.url).resolve("@copilotkit/react-core/package.json"));
  const packageDir = join(dirname(dirname(reactCore)), "web-inspector");
  return {
    loaded: false,
    configure: vi.fn(),
    entryPath: join(packageDir, "dist", "index.mjs"),
    packageJsonPath: join(packageDir, "package.json")
  };
});

vi.mock(inspectorPackage.entryPath, async (importOriginal) => {
  inspectorPackage.loaded = true;
  const original = await importOriginal<{ configureWebInspectorElement: (...args: unknown[]) => unknown }>();
  inspectorPackage.configure.mockImplementation(original.configureWebInspectorElement);
  return { ...original, configureWebInspectorElement: inspectorPackage.configure };
});

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { AgentCopyRefusedError, DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { buildFrontendContentSecurityPolicy } from "../lib/frontend-security-headers";
import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs } from "../test-helpers/agui-fixture-server";
import { CopilotChatHost } from "./copilot-chat-host";

installBrowserLayoutStubs();

type AgentLike = { threadId: string; messages: Array<{ id: string }>; subscribers: unknown[] };
type CoreLike = {
  getAgent(id: string): AgentLike | undefined;
  subscribe(subscriber: { onAgentRunStarted?: (event: { agent: AgentLike }) => void }): { unsubscribe(): void };
};
type InspectorElement = HTMLElement & { core: CoreLike | null; isOpen: boolean };
type JsdomInstance = { reconfigure(options: { url: string }): void };
const jsdom = (globalThis as unknown as { jsdom: JsdomInstance }).jsdom;

const API_ORIGIN = "http://localhost:3001";
// The origins that CopilotKit 1.85.0 calls from a development Inspector: two
// feeds when it mounts, and anonymous usage events when it opens.
const COPILOTKIT_ORIGINS = ["https://cdn.copilotkit.ai", "https://telemetry.copilotkit.ai"];

let server: FixtureServer;
/** Every request URL, in order. */
let requests: string[];

beforeEach(() => {
  server = new FixtureServer();
  requests = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return server.fetch(input, init);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  inspectorPackage.configure.mockClear();
  jsdom.reconfigure({ url: "http://localhost:3000/" });
});

function hostElement(sessionId = "s-1") {
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
      events={{}}
    />
  );
}

const savedReply = (sessionId: string) => idleHistory([
  { id: `u-${sessionId}`, role: "user", content: `Question in ${sessionId}` },
  { id: `a-${sessionId}`, role: "assistant", content: `Answer in ${sessionId}` }
], { threadId: sessionId });

// The package types `isOpen` as private. The tests read it as the open state.
const inspectors = () => [...document.querySelectorAll("cpk-web-inspector")] as unknown as InspectorElement[];
const optIn = () => {
  vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
  vi.stubEnv("NODE_ENV", "development");
};
/** The requests to the backend, as "METHOD /path". */
const apiCalls = () => server.calls.filter((_, index) => requests[index]!.startsWith(`${API_ORIGIN}/`));
const otherOrigins = () => [...new Set(requests.map((url) => new URL(url).origin))]
  .filter((origin) => origin !== API_ORIGIN);

/** Renders the host and waits for the saved history. */
async function renderClosedHost() {
  server.connect("s-1", savedReply("s-1"));
  const { container } = render(hostElement());
  await screen.findByText("Answer in s-1");
  return container;
}

/** The element that CopilotKit 1.85.0 renders, in the same render, when its
 *  gate opens. The Inspector element goes into it after the package loads. */
const inspectorMounts = (container: HTMLElement) =>
  [...container.querySelectorAll("span")].filter((span) => span.style.display === "contents");

function expectNoInspector(container: HTMLElement) {
  expect(inspectorMounts(container)).toEqual([]);
  expect(inspectors()).toEqual([]);
  expect(inspectorPackage.loaded).toBe(false);
  expect(inspectorPackage.configure).not.toHaveBeenCalled();
  expect(screen.queryByTestId("copilot-inspector-button")).toBeNull();
  expect(requests).toEqual([`${API_ORIGIN}/sessions/s-1/connect`]);
}

// These tests must run before the first test that loads the package.
describe("the chat host without the Inspector", () => {
  it("does not load the Inspector by default", async () => {
    expectNoInspector(await renderClosedHost());
  });

  it("does not load it for the opt-in in a production build", async () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
    vi.stubEnv("NODE_ENV", "production");
    expectNoInspector(await renderClosedHost());
  });

  it("does not load it for an opt-in value other than 1", async () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "true");
    vi.stubEnv("NODE_ENV", "development");
    expectNoInspector(await renderClosedHost());
  });

  it("does not load it on a host that is not loopback", async () => {
    optIn();
    jsdom.reconfigure({ url: "https://cogniplane.example/chat" });
    expectNoInspector(await renderClosedHost());
  });
});

describe("the chat host with the Inspector opt-in in local development", () => {
  it("mounts the pinned Inspector on the core of the chat", async () => {
    optIn();
    const container = await renderClosedHost();
    // The first opt-in loads the real package. Wait for that import before
    // checking the element, including when other test workers compile code.
    await act(async () => { await vi.dynamicImportSettled(); });
    await waitFor(() => expect(inspectors()).toHaveLength(1));

    const [inspector] = inspectors();
    expect(inspectorMounts(container).map((mount) => mount.firstElementChild)).toEqual([inspector]);
    expect(inspectorPackage.configure).toHaveBeenCalledTimes(1);
    expect(inspectorPackage.configure).toHaveBeenCalledWith(inspector, inspector!.core, {
      development: true, framework: "react", sdkVersion: "1.85.0"
    });
    const agent = inspector!.core!.getAgent("deepAgents");
    expect(agent).toBeInstanceOf(DeepAgentsBrowserAgent);
    expect(agent!.threadId).toBe("s-1");
    expect(inspector!.shadowRoot).not.toBeNull();

    // The Inspector reads the agent. It starts no run and no connection. Its
    // feeds go to CopilotKit, not to the backend. This is the first test that
    // loads the package, and the feeds load once per page.
    expect(apiCalls()).toEqual(["GET /sessions/s-1/connect"]);
    await waitFor(() => expect(otherOrigins()).toEqual(["https://cdn.copilotkit.ai"]));
    expect(server.sent).toEqual([]);
  });

  it("opens from the toolbar of an assistant message", async () => {
    optIn();
    await renderClosedHost();
    const button = await screen.findByTestId("copilot-inspector-button");
    expect(button.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("a-s-1");
    const [inspector] = inspectors();
    expect(inspector!.isOpen).toBe(false);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(inspector!.isOpen).toBe(true);
    expect(apiCalls()).toEqual(["GET /sessions/s-1/connect"]);
  });

  it("shows the messages, state, and tool events of the chat", async () => {
    optIn();
    await renderClosedHost();
    await waitFor(() => expect(inspectors()).toHaveLength(1));
    const [inspector] = inspectors();
    server.messageReplies = [(stream) => {
      stream.push(
        ev.runStarted("a2"),
        { type: "TOOL_CALL_START", toolCallId: "tc-1", toolCallName: "web_search", parentMessageId: "r-2" },
        { type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: "{\"query\":\"inspector\"}" },
        { type: "TOOL_CALL_END", toolCallId: "tc-1" },
        ev.planDelta("- [x] Search"),
        ev.textStart("r-2"), ev.text("r-2", "Live reply"), ev.textEnd("r-2"),
        ev.runFinished("a2")
      );
      stream.finish();
    }];
    fireEvent.change(screen.getByTestId("copilot-chat-textarea"), { target: { value: "Search for me" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("copilot-chat-textarea"), { key: "Enter" });
    });
    await screen.findByText("Live reply");

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("copilot-inspector-button").at(-1)!);
    });
    const shadow = inspector!.shadowRoot!;
    const showMenu = async (key: string) => {
      await act(async () => {
        (shadow.querySelector(`[data-inspector-menu-key="${key}"]`) as HTMLElement).click();
      });
      return shadow.textContent ?? "";
    };
    const events = await showMenu("ag-ui-events");
    expect(events).toContain("TOOL_CALL_START");
    expect(events).toContain("web_search");
    expect(events).toContain("STATE_DELTA");
    const agentView = await showMenu("agents");
    expect(agentView).toContain("Live reply");
    expect(agentView).toContain("Search");

    // Only the message that the user sent reached the backend.
    expect(server.sent.map((body) => body.sessionId)).toEqual(["s-1"]);
  });

  it("keeps the playground of the Inspector away from the session", async () => {
    optIn();
    await renderClosedHost();
    await waitFor(() => expect(inspectors()).toHaveLength(1));
    const [inspector] = inspectors();
    const agent = inspector!.core!.getAgent("deepAgents")!;
    const messageIds = agent.messages.map((message) => message.id);
    const subscriberCount = agent.subscribers.length;
    const runsStarted: string[] = [];
    const watch = inspector!.core!.subscribe({ onAgentRunStarted: ({ agent: started }) => { runsStarted.push(started.threadId); } });
    const failures: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { failures.push(args); });

    await act(async () => {
      fireEvent.click(await screen.findByTestId("copilot-inspector-button"));
    });
    const shadow = inspector!.shadowRoot!;
    await act(async () => {
      (shadow.querySelector("[data-inspector-menu-key=\"playground\"]") as HTMLElement).click();
    });
    const input = shadow.querySelector(".cpk-playground-form textarea") as HTMLTextAreaElement;
    input.value = "Run from the playground";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      (shadow.querySelector(".cpk-playground-form") as HTMLFormElement).requestSubmit();
    });

    await waitFor(() => expect(shadow.querySelector("[data-playground-error]")?.textContent).toContain(new AgentCopyRefusedError().message));
    watch.unsubscribe();
    // The copy refused before CopilotKit announced a run, so the chat keeps
    // its active thread, and no request reached the backend.
    expect(runsStarted).toEqual([]);
    expect(apiCalls()).toEqual(["GET /sessions/s-1/connect"]);
    expect(server.sent).toEqual([]);
    expect(agent.threadId).toBe("s-1");
    expect(agent.messages.map((message) => message.id)).toEqual(messageIds);
    expect(agent.subscribers).toHaveLength(subscriberCount);
    expect(screen.getByText("Answer in s-1")).toBeTruthy();
    expect(failures.flat().some((value) => value instanceof AgentCopyRefusedError)).toBe(false);
  });

  it("moves to the core of the next session and removes the old Inspector", async () => {
    optIn();
    server.connect("s-1", savedReply("s-1"));
    server.connect("s-2", savedReply("s-2"));
    const { rerender } = render(hostElement("s-1"));
    await screen.findByText("Answer in s-1");
    await waitFor(() => expect(inspectors()).toHaveLength(1));
    const [first] = inspectors();
    const firstCore = first!.core;

    rerender(hostElement("s-2"));
    await screen.findByText("Answer in s-2");
    await waitFor(() => expect(inspectors()).toHaveLength(1));
    await waitFor(() => expect(inspectors()[0]).not.toBe(first));

    const [second] = inspectors();
    expect(first!.isConnected).toBe(false);
    expect(second!.core).not.toBe(firstCore);
    expect(second!.core!.getAgent("deepAgents")!.threadId).toBe("s-2");
    expect(inspectorPackage.configure).toHaveBeenCalledTimes(2);
    expect(inspectorPackage.configure).toHaveBeenLastCalledWith(second, second!.core, expect.objectContaining({ development: true }));
    expect(apiCalls()).toEqual(["GET /sessions/s-1/connect", "GET /sessions/s-2/connect"]);
    expect(server.sent).toEqual([]);
  });

  it("sends nothing to CopilotKit that the development CSP allows", async () => {
    optIn();
    await renderClosedHost();
    await act(async () => {
      fireEvent.click(await screen.findByTestId("copilot-inspector-button"));
    });

    // The feeds load once per page, so an earlier test may have loaded them.
    // The development CSP blocks every CopilotKit origin in a browser.
    expect(otherOrigins()).toContain("https://telemetry.copilotkit.ai");
    for (const origin of otherOrigins()) expect(COPILOTKIT_ORIGINS).toContain(origin);
    const csp = buildFrontendContentSecurityPolicy({ nonce: "dev", apiUrl: API_ORIGIN, development: true });
    const connectSources = csp.split("; ").find((directive) => directive.startsWith("connect-src "))!.split(" ").slice(1);
    for (const origin of COPILOTKIT_ORIGINS) expect(connectSources).not.toContain(origin);
    expect(connectSources.some((source) => source === "*" || source === "https:" || source.includes("copilotkit"))).toBe(false);
  });
});

describe("the pinned Inspector package", () => {
  it("is the version that the chat host was checked against", async () => {
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(inspectorPackage.packageJsonPath, "utf-8")) as { version: string };
    expect(version).toBe("1.85.0");
  });
});
