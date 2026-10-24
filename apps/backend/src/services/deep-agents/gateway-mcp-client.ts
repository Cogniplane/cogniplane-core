// The Deep Agents runtime's MCP client for the platform gateway (/mcp/:serverId).
//
// Each server gets its own MCPAdapter. The adapter opens one streamable HTTP
// connection with the session's `Authorization: Bearer rt_...` header and keeps
// it for the life of the session runtime. The tools come from `loadMcpTools`
// over a facade of that connection, so the trusted turn context and approval
// proof of each call travel in `params._meta`. mcp-invocation-scope.ts has the
// details. The tool arguments and schemas are the server's own.

import { MCPAdapter, loadMcpTools, type LoadMcpToolsOptions } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import type { McpInvocationMetadata } from "../mcp/invocation-metadata.js";
import { McpInvocationScope } from "./mcp-invocation-scope.js";

export type GatewayMcpServer = { id: string; url: string; authorization: string };

/** One proposed call, as the beforeToolCall hook sees it. */
export type GatewayMcpCall = {
  name: string;
  serverId: string;
  args: Record<string, unknown>;
  /** The graph's tool-call ID, which keys the backend-held approval proof. */
  toolCallId: string | undefined;
};

type Logger = { warn: (details: Record<string, unknown>, message: string) => void };

type BeforeToolCall = NonNullable<LoadMcpToolsOptions["beforeToolCall"]>;

function toolCallIdOf(config: Parameters<BeforeToolCall>[2]): string | undefined {
  // LangChain sets `toolCall` when a tool is invoked with a tool call; the
  // agent's ToolNode also sets `toolCallId`. Both name the same call.
  const { toolCall, toolCallId } = (config ?? {}) as { toolCall?: { id?: unknown }; toolCallId?: unknown };
  const id = toolCall?.id ?? toolCallId;
  return typeof id === "string" && id ? id : undefined;
}

export class GatewayMcpClient {
  readonly #scope = new McpInvocationScope();
  readonly #adapters: ReadonlyArray<{ server: GatewayMcpServer; adapter: MCPAdapter }>;
  readonly #beforeToolCall: BeforeToolCall;
  // SDK adapters can reconnect after close. A retired session client cannot.
  #closed = false;

  /**
   * The constructor makes the adapters before anything awaits, so `close()`
   * reaches every connection that a load in progress can open.
   */
  constructor(private readonly options: {
    servers: readonly GatewayMcpServer[];
    /** The trusted values for one call. Read when the call runs, never earlier. */
    resolveInvocation: (call: GatewayMcpCall) => McpInvocationMetadata | undefined;
    logger: Logger;
    sessionId: string;
  }) {
    this.#adapters = options.servers.map((server) => ({ server, adapter: new MCPAdapter({
      servers: {
        [server.id]: {
          transport: "http",
          // The gateway implements the 2025 JSON-RPC protocol. Legacy mode
          // connects with it directly instead of probing for the modern one.
          mode: "legacy",
          url: server.url,
          headers: { Authorization: server.authorization }
        }
      },
      // The default "throw" would let one unreachable server take down every
      // gateway tool. Log and skip degrades per server instead.
      onConnectionError: ({ serverName, error }) => {
        if (this.#closed) return;
        options.logger.warn(
          { err: error, serverName, sessionId: options.sessionId },
          "Deep Agents MCP server connection failed; its tools are skipped"
        );
      },
      // One tool with a schema that the adapter cannot convert must not drop the server.
      throwOnLoadError: false
    }) }));
    this.#beforeToolCall = (request, _state, config) => {
      if (this.#closed) throw new Error("The MCP gateway client is closed.");
      this.#scope.attach(options.resolveInvocation({
        name: request.name,
        serverId: request.serverName,
        args: (request.args ?? {}) as Record<string, unknown>,
        toolCallId: toolCallIdOf(config)
      }));
      // No argument or header changes. The arguments go out as the model wrote them.
    };
  }

  /**
   * The tools of each server, in server order. The servers load in parallel, so
   * the slowest server sets the load time, not the sum of all. A server that
   * fails to connect or to list its tools is skipped with a warning.
   */
  async loadTools(): Promise<Array<{ serverId: string; tools: DynamicStructuredTool[] }>> {
    const loaded = await Promise.all(this.#adapters.map(({ server, adapter }) => this.#loadServerTools(server, adapter)));
    if (this.#closed) return [];
    return loaded.filter((entry) => entry !== null);
  }

  async #loadServerTools(
    server: GatewayMcpServer,
    adapter: MCPAdapter
  ): Promise<{ serverId: string; tools: DynamicStructuredTool[] } | null> {
    if (this.#closed) return null;
    try {
      // Undefined when the connection failed; onConnectionError has logged it.
      const client = await adapter.getClient(server.id);
      if (this.#closed || !client) return null;
      const tools = await loadMcpTools(server.id, this.#scope.client(client), {
        beforeToolCall: this.#beforeToolCall,
        throwOnLoadError: false,
        // Tool names are the server's own. The graph drops collisions itself.
        prefixToolNameWithServerName: false
      });
      if (this.#closed) return null;
      return { serverId: server.id, tools: tools.map((tool) => this.#scope.bind(tool)) };
    } catch (err) {
      if (this.#closed) return null;
      this.options.logger.warn(
        { err, serverId: server.id, sessionId: this.options.sessionId },
        "Failed to load MCP tools from gateway server for Deep Agents session"
      );
      return null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#adapters.map(({ adapter }) => adapter.close()));
  }
}
