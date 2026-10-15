// @vitest-environment jsdom
// Runs a real DeepAgentsBrowserAgent through @ag-ui/client against a stubbed
// 429 response. It checks the error shape from runHttpRequest and the
// onRunFailed mutation. A fake agent cannot prove either.
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  createApiHeaders: (init?: HeadersInit) => new Headers(init),
  refreshAccessToken: vi.fn(),
  request: vi.fn()
}));

import { renderSessionHooks } from "../../test-helpers/agui-session-hooks";
import { DeepAgentsBrowserAgent, isSessionBusyError } from "./deep-agents-browser-agent";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBusyResponse() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "session_busy" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    })
  ));
}

describe("a send refused as session_busy", () => {
  it("removes the unsent user message and shows the other turn, not a failed turn", async () => {
    stubBusyResponse();
    // @ag-ui/client logs the rethrown run error; it is expected here.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    // An earlier turn, as the session connection restores it.
    agent.setMessages([{ id: "saved", role: "user", content: "earlier" }]);
    const { result, onTurnSettled } = renderSessionHooks(agent);

    agent.addMessage({ id: "optimistic", role: "user", content: "second question" });
    let thrown: unknown;
    await act(async () => {
      await agent.runAgent().catch((error: unknown) => { thrown = error; });
    });

    expect(isSessionBusyError(thrown)).toBe(true);
    expect(agent.messages.map((message) => message.id)).toEqual(["saved"]);
    expect(result.current.connection).toMatchObject({
      busyRefused: true, running: false, remoteRunning: true, activity: null
    });
    expect(onTurnSettled).not.toHaveBeenCalled();
    expect(result.current.events.notices).toEqual([]);
  });

  it("keeps pending approvals that belong to the running turn", async () => {
    stubBusyResponse();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const approval = {
      approvalId: "ap-1", sessionId: "s-1", itemId: "item", kind: "command_execution",
      title: "Run command", summary: "ls", status: "pending", createdAt: "2026-09-22T00:00:00.000Z"
    } as never;
    const { result } = renderSessionHooks(agent, { initialApprovals: [approval] });

    agent.addMessage({ id: "optimistic", role: "user", content: "hi" });
    await act(async () => {
      await agent.runAgent().catch(() => undefined);
    });

    expect(result.current.events.approvals.map((row) => row.approvalId)).toEqual(["ap-1"]);
  });
});
