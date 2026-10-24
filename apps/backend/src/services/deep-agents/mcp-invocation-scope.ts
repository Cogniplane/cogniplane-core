// Carries the trusted values of one MCP tool execution from the adapter's
// beforeToolCall hook to the `tools/call` request of the same execution.
//
// @langchain/mcp-adapters 2 validates the arguments that beforeToolCall returns
// against the tool's own input schema, and it builds `params._meta` itself. The
// hook therefore cannot add `toolContextId` or `policyApprovalId`. A strict
// schema rejects them, and the model must not see them. Instead, each execution
// of a bound tool runs in its own AsyncLocalStorage slot. The hook writes the
// slot, and the client facade copies it into `params._meta` of the request.
// Parallel executions have separate slots and share one MCP connection.

import { AsyncLocalStorage } from "node:async_hooks";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { loadMcpTools } from "@langchain/mcp-adapters";

import { withInvocationMetadata, type McpInvocationMetadata } from "../mcp/invocation-metadata.js";

/** The SDK client type that `loadMcpTools` accepts. */
export type McpToolClient = Parameters<typeof loadMcpTools>[1];

type Slot = { metadata?: McpInvocationMetadata };

export class McpInvocationScope {
  readonly #slots = new AsyncLocalStorage<Slot>();

  /**
   * Runs each execution of `tool` in a new, empty slot. The tool, its name and
   * its schema stay the same object.
   */
  bind<T extends DynamicStructuredTool>(tool: T): T {
    const execute = tool.func;
    const slots = this.#slots;
    tool.func = function (this: unknown, ...args: Parameters<typeof execute>) {
      return slots.run({}, () => execute.apply(tool, args));
    } as typeof execute;
    return tool;
  }

  /** Sets the trusted values of the current execution. The beforeToolCall hook calls it. */
  attach(metadata: McpInvocationMetadata | undefined): void {
    const slot = this.#slots.getStore();
    if (!slot) throw new Error("This MCP tool call has no invocation scope.");
    slot.metadata = metadata;
  }

  /**
   * The client that the adapter's tools use. It forwards discovery and calls to
   * `client` and puts the current slot's values into `params._meta`, replacing
   * any value already there. It has no `fork`, so per-call headers cannot make
   * the adapter open another connection.
   */
  client(client: McpToolClient): McpToolClient {
    const slots = this.#slots;
    const facade: Pick<McpToolClient, "getProtocolEra" | "listTools" | "callTool"> = {
      getProtocolEra: () => client.getProtocolEra(),
      listTools: (params, options) => client.listTools(params, options),
      callTool: (params, options) => {
        const slot = slots.getStore();
        // A call outside a bound execution could only go without its context.
        if (!slot) return Promise.reject(new Error("This MCP tool call has no invocation scope."));
        return client.callTool(withInvocationMetadata(params, slot.metadata), options);
      }
    };
    // loadMcpTools reads only these three members and checks for `fork`.
    return facade as McpToolClient;
  }
}
