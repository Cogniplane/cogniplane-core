// @vitest-environment jsdom
//
// The real ext-apps PostMessageTransport runs beneath the subclass, so these
// tests also show that its private message handler is still where the
// subclass expects it. Peers are real jsdom iframe windows.

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { OriginBoundPostMessageTransport } from "./mcp-app-origin-transport";

const SANDBOX_ORIGIN = "https://sandbox.example.test";
const REQUEST = { jsonrpc: "2.0", id: 7, method: "ui/message", params: { role: "user", content: [] } };

function frameWindow(): Window {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  return iframe.contentWindow!;
}

function deliver(source: Window | null, origin: string, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function startTransport(peer = frameWindow()) {
  const transport = new OriginBoundPostMessageTransport(peer, SANDBOX_ORIGIN);
  transport.onmessage = vi.fn();
  transport.onerror = vi.fn();
  await transport.start();
  return { peer, transport };
}

it("delivers a JSON-RPC message from the sandbox window at the sandbox origin", async () => {
  const { peer, transport } = await startTransport();
  deliver(peer, SANDBOX_ORIGIN, REQUEST);
  expect(transport.onmessage).toHaveBeenCalledOnce();
  expect(transport.onmessage).toHaveBeenCalledWith(REQUEST);
  await transport.close();
});

it.each([
  ["another site", "https://evil.example.test"],
  ["an opaque origin", "null"],
  ["a longer host name", "https://sandbox.example.test.evil.test"],
  ["another scheme", "http://sandbox.example.test"],
  ["another port", "https://sandbox.example.test:8443"],
  ["the host itself", window.location.origin],
  ["an empty origin", ""]
])("drops a message from the sandbox window with %s as its origin", async (_name, origin) => {
  const { peer, transport } = await startTransport();
  deliver(peer, origin, REQUEST);
  expect(transport.onmessage).not.toHaveBeenCalled();
  expect(transport.onerror).not.toHaveBeenCalled();
  await transport.close();
});

it("still drops a message from another window at the sandbox origin", async () => {
  const { transport } = await startTransport();
  deliver(frameWindow(), SANDBOX_ORIGIN, REQUEST);
  deliver(null, SANDBOX_ORIGIN, REQUEST);
  expect(transport.onmessage).not.toHaveBeenCalled();
  await transport.close();
});

it("keeps the JSON-RPC validation of ext-apps", async () => {
  const { peer, transport } = await startTransport();
  deliver(peer, SANDBOX_ORIGIN, { type: "not-json-rpc" });
  expect(transport.onmessage).not.toHaveBeenCalled();
  expect(transport.onerror).not.toHaveBeenCalled();
  deliver(peer, SANDBOX_ORIGIN, { jsonrpc: "2.0", method: 42 });
  expect(transport.onmessage).not.toHaveBeenCalled();
  expect(transport.onerror).toHaveBeenCalledOnce();
  await transport.close();
});

it("sends only to the sandbox origin", async () => {
  const { peer, transport } = await startTransport();
  const post = vi.spyOn(peer, "postMessage");
  const notification = { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: "<p>Widget</p>" } };
  await transport.send(notification as never);
  await transport.send(REQUEST as never);
  expect(post.mock.calls).toEqual([[notification, SANDBOX_ORIGIN], [REQUEST, SANDBOX_ORIGIN]]);
  await transport.close();
});

it("stops listening and reports the close", async () => {
  const { peer, transport } = await startTransport();
  const onclose = vi.fn();
  transport.onclose = onclose;
  await transport.close();
  expect(onclose).toHaveBeenCalledOnce();
  deliver(peer, SANDBOX_ORIGIN, REQUEST);
  expect(transport.onmessage).not.toHaveBeenCalled();
});

it("registers its message listener when it starts", async () => {
  const add = vi.spyOn(window, "addEventListener");
  const peer = frameWindow();
  const transport = new OriginBoundPostMessageTransport(peer, SANDBOX_ORIGIN);
  transport.onmessage = vi.fn();
  expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
  await transport.start();
  expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
  deliver(peer, SANDBOX_ORIGIN, REQUEST);
  expect(transport.onmessage).toHaveBeenCalledOnce();
  await transport.close();
});
