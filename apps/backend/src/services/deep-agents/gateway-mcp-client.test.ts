import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { gatewayErrorsAsResults } from "./gateway-mcp-client.js";
import type { McpToolClient } from "./mcp-invocation-scope.js";

// The SDK error classes of the MCP client that @langchain/mcp-adapters uses.
// The backend does not depend on the SDK directly, so resolve it from the adapter.
const adapterPath = createRequire(import.meta.url).resolve("@langchain/mcp-adapters");
const sdk = await import(pathToFileURL(createRequire(adapterPath).resolve("@modelcontextprotocol/client")).href) as {
  ProtocolError: new (code: number, message: string, data?: unknown) => Error;
  UrlElicitationRequiredError: new (elicitations: unknown[], message: string) => Error;
  UnsupportedProtocolVersionError: new (data: { supported: string[]; requested: string }, message: string) => Error;
};

function clientThatThrows(error: unknown): McpToolClient {
  return { callTool: vi.fn(async () => { throw error; }) } as unknown as McpToolClient;
}

const call = { name: "search_docs", arguments: {} };

describe("gatewayErrorsAsResults", () => {
  it("gives a JSON-RPC error answer back as an isError result with the gateway's message", async () => {
    const client = gatewayErrorsAsResults(clientThatThrows(new sdk.ProtocolError(-32004, "Blocked by a policy rule.")));

    await expect(client.callTool(call, {})).resolves.toEqual({
      content: [{ type: "text", text: "Blocked by a policy rule." }], isError: true
    });
  });

  it("redacts a secret in the message, which the SDK's own output check does not redact", async () => {
    const answer = new sdk.ProtocolError(-32602, "Structured content does not match the tool's output schema: Bearer abcdef0123456789abcdef");

    const result = await gatewayErrorsAsResults(clientThatThrows(answer)).callTool(call, {});

    expect(JSON.stringify(result)).not.toContain("abcdef0123456789abcdef");
    expect(result).toMatchObject({ isError: true });
  });

  it("passes a successful result through unchanged", async () => {
    const result = { content: [{ type: "text", text: "found" }], isError: false };
    const inner = { callTool: vi.fn(async () => result) } as unknown as McpToolClient;

    await expect(gatewayErrorsAsResults(inner).callTool(call, { timeout: 5 })).resolves.toBe(result);
    expect(inner.callTool).toHaveBeenCalledWith(call, { timeout: 5 });
  });

  it("still throws a transport failure", async () => {
    const failure = new TypeError("fetch failed");

    await expect(gatewayErrorsAsResults(clientThatThrows(failure)).callTool(call, {})).rejects.toBe(failure);
  });

  it("still throws an error answer that arrives after the turn was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const answer = new sdk.ProtocolError(-32000, "Tool call failed.");

    await expect(gatewayErrorsAsResults(clientThatThrows(answer)).callTool(call, { signal: controller.signal }))
      .rejects.toBe(answer);
  });

  it("still throws the SDK's special protocol errors, which keep the name ProtocolError", async () => {
    const elicitation = new sdk.UrlElicitationRequiredError(
      [{ mode: "url", url: "https://example.test/consent", elicitationId: "e-1", message: "Open this URL." }], "Open this URL.");
    const version = new sdk.UnsupportedProtocolVersionError({ supported: ["2025-06-18"], requested: "2099-01-01" }, "Unsupported.");
    expect(elicitation.name).toBe("ProtocolError");

    await expect(gatewayErrorsAsResults(clientThatThrows(elicitation)).callTool(call, {})).rejects.toBe(elicitation);
    await expect(gatewayErrorsAsResults(clientThatThrows(version)).callTool(call, {})).rejects.toBe(version);
  });
});
