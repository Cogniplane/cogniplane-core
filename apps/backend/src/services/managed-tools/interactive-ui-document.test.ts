// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";

import { renderInteractiveUiDocument } from "./interactive-ui-document.js";

type WidgetWindow = Window & { cogniplane: { sendMessage: (text: string) => Promise<{ isError?: boolean }> } };
const widget = window as unknown as WidgetWindow;

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function start() {
  const html = renderInteractiveUiDocument({ title: '<Title>"', description: "A & B", html: "<button>Explore</button>" });
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  const send = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  window.eval(parsed.querySelector("script")!.textContent!);
  return { html, send };
}

function receive(data: unknown, source: Window | null = window.parent) {
  window.dispatchEvent(new MessageEvent("message", { source, data }));
}

function initialize() {
  receive({ jsonrpc: "2.0", id: "cogniplane-initialize", result: {
    protocolVersion: "2026-01-26", hostContext: { theme: "dark" }
  } });
}

it("escapes labels, preserves executable fragments, and initializes before model scripts", () => {
  const fragment = '<script>document.addEventListener("DOMContentLoaded", () => {});</script>';
  const html = renderInteractiveUiDocument({ title: "<img>&", description: '"Summary"', html: fragment });
  expect(html).toContain("&lt;img&gt;&amp;");
  expect(html).toContain("&quot;Summary&quot;");
  expect(html).toContain(fragment);
  expect(html.indexOf("window.cogniplane")).toBeLessThan(html.indexOf(fragment));
});

it("uses the handshake, ignores other sources, and permits one confirmed or cancelled message at a time", async () => {
  const { send } = start();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: "ui/initialize",
    params: { protocolVersion: "2026-01-26", appInfo: expect.any(Object), appCapabilities: {} } }), "*");
  expect(await widget.cogniplane.sendMessage("Too early")).toEqual({ isError: true });
  receive({ jsonrpc: "2.0", id: "cogniplane-initialize", result: { protocolVersion: "2026-01-26" } }, null);
  expect(await widget.cogniplane.sendMessage("Wrong source")).toEqual({ isError: true });
  initialize();
  expect(document.documentElement.dataset.theme).toBe("dark");
  const cancelled = widget.cogniplane.sendMessage("Explain the estimate");
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ method: "ui/message",
    params: { role: "user", content: [{ type: "text", text: "Explain the estimate" }] } }), "*");
  expect(await widget.cogniplane.sendMessage("Duplicate")).toEqual({ isError: true });
  receive({ jsonrpc: "2.0", id: "cogniplane-message-1", result: { isError: true } });
  expect(await cancelled).toEqual({ isError: true });
  const confirmed = widget.cogniplane.sendMessage("Try again");
  receive({ jsonrpc: "2.0", id: "cogniplane-message-2", result: {} });
  expect(await confirmed).toEqual({});
  receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  expect(document.documentElement.dataset.theme).toBe("light");
  const pending = widget.cogniplane.sendMessage("Close this view");
  window.dispatchEvent(new Event("pagehide"));
  expect(await pending).toEqual({ isError: true });
});

it("checks the host message limit before it asks, so the widget shell and the host agree", async () => {
  const { send } = start();
  initialize();
  send.mockClear();

  expect(await widget.cogniplane.sendMessage("x".repeat(MCP_APP_MESSAGE_MAX_CHARS + 1))).toEqual({ isError: true });
  expect(send).not.toHaveBeenCalled();

  const atLimit = widget.cogniplane.sendMessage("x".repeat(MCP_APP_MESSAGE_MAX_CHARS));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: "ui/message" }), "*");
  receive({ jsonrpc: "2.0", id: "cogniplane-message-1", result: {} });
  expect(await atLimit).toEqual({});
});

it("fails host requests after initialization times out while leaving local markup available", async () => {
  vi.useFakeTimers();
  start();
  vi.advanceTimersByTime(10_001);
  initialize();
  expect(await widget.cogniplane.sendMessage("Unavailable")).toEqual({ isError: true });
  expect(document.querySelector("button")?.textContent).toBe("Explore");
});
