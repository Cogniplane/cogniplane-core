// @vitest-environment jsdom
// Runs a real DeepAgentsBrowserAgent through @ag-ui/client against stubbed
// responses that the message route sends before it saves the user message.
// session-busy.test.ts covers the session_busy refusal.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  createApiHeaders: (init?: HeadersInit) => new Headers(init),
  refreshAccessToken: vi.fn(),
  request: vi.fn()
}));

import { DeepAgentsBrowserAgent } from "./deep-agents-browser-agent";
import { refusedSendNotice, useAguiCustomEvents } from "./use-agui-custom-events";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubResponse(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  ));
}

async function sendRefused(status: number, body: unknown) {
  stubResponse(status, body);
  // @ag-ui/client logs the rethrown run error; it is expected here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const agent = new DeepAgentsBrowserAgent({
    sessionId: "s-1",
    initialMessages: [{ id: "saved", role: "user", content: "earlier" }]
  });
  const onRunSettled = vi.fn();
  const onSessionBusy = vi.fn();
  const view = renderHook(() => useAguiCustomEvents(agent, { onRunSettled, onSessionBusy }));
  agent.addMessage({ id: "optimistic", role: "user", content: "second question" });
  let thrown: unknown;
  await act(async () => {
    await agent.runAgent().catch((error: unknown) => { thrown = error; });
  });
  return { agent, result: view.result, onRunSettled, onSessionBusy, thrown };
}

describe("a send refused before its stream", () => {
  it("removes the unsent message and tells the user that the running-turn limit refused it", async () => {
    const { agent, result, onRunSettled, onSessionBusy, thrown } = await sendRefused(429, { error: "running_turn_limit" });

    // The shape the hook reads comes from @ag-ui/client's runHttpRequest.
    expect(thrown).toMatchObject({ status: 429, payload: { error: "running_turn_limit" } });
    expect(agent.messages.map((message) => message.id)).toEqual(["saved"]);
    expect(result.current.notices).toEqual([expect.objectContaining({
      level: "error",
      title: "Your message was not sent",
      message: "Too many agents are running for you or your organization. Wait for an agent to finish, or stop one. Then send your message again."
    })]);
    // No turn started, so the turn is not failed and nothing needs a refresh.
    expect(result.current.isRunning).toBe(false);
    expect(result.current.turnActivity).toBeNull();
    expect(onRunSettled).not.toHaveBeenCalled();
    // The busy flow waits for another turn. This refusal must not enter it.
    expect(onSessionBusy).not.toHaveBeenCalled();
  });

  it("shows the backend's own message for a rate limit", async () => {
    const { agent, result } = await sendRefused(429, {
      error: "limit_exceeded", limitType: "usage_quota", message: "User daily turn quota exceeded."
    });
    expect(agent.messages.map((message) => message.id)).toEqual(["saved"]);
    expect(result.current.notices.map((notice) => notice.message)).toEqual(["User daily turn quota exceeded."]);
  });

  it("treats a draining server as a refusal", async () => {
    const { agent, result } = await sendRefused(503, { error: "server_draining" });
    expect(agent.messages.map((message) => message.id)).toEqual(["saved"]);
    expect(result.current.notices.map((notice) => notice.message)).toEqual([
      "The server does not accept new messages at this time. Send your message again in a few minutes."
    ]);
  });

  it("keeps the message of a 500 response, because the backend can fail after it saves the message", async () => {
    const { agent, result, onRunSettled } = await sendRefused(500, { error: "internal_error" });
    expect(agent.messages.map((message) => message.id)).toEqual(["saved", "optimistic"]);
    expect(result.current.notices).toEqual([]);
    expect(result.current.turnActivity).toMatchObject({ isRunning: false, failed: true });
    expect(onRunSettled).toHaveBeenCalledOnce();
  });

  it("removes the notice when the user sends again", async () => {
    const { agent, result } = await sendRefused(429, { error: "running_turn_limit" });
    expect(result.current.notices).toHaveLength(1);

    stubResponse(200, {});
    agent.addMessage({ id: "retry", role: "user", content: "second question" });
    await act(async () => {
      await agent.runAgent().catch(() => undefined);
    });

    expect(result.current.notices).toEqual([]);
  });
});

describe("refusedSendNotice", () => {
  const httpError = (status: number, payload?: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, payload });

  it("gives a generic reason when the refusal has no message", () => {
    expect(refusedSendNotice(httpError(404, { error: "session_not_found" }))?.message)
      .toBe("The server did not accept the message (HTTP 404).");
  });

  it("ignores errors that are not refusals", () => {
    expect(refusedSendNotice(new TypeError("network error"))).toBeNull();
    expect(refusedSendNotice(httpError(502))).toBeNull();
    expect(refusedSendNotice(httpError(503, { error: "unavailable" }))).toBeNull();
  });
});
