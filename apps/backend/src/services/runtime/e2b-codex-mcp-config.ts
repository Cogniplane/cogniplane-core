/**
 * Codex configuration helpers for the E2B runtime.
 *
 * Codex app-server in some versions ignores `[mcp_servers.*]` from project-level
 * `codex.toml`, so the workspace MCP block is duplicated into the sandbox-global
 * `~/.codex/config.toml` to guarantee discovery. These helpers render that
 * global config and the stdio launch command.
 */

export type CodexProxyConfig = {
  /** Backend route the sandbox should call instead of api.openai.com,
   * e.g. "https://backend.example/llm/openai/v1". Must include `/v1`. */
  baseUrl: string;
};

export function buildSandboxCodexConfig(input: {
  model: string;
  workspaceRoot: string;
  mcpServersToml?: string;
  /**
   * When set, configure Codex to route model calls through the backend's
   * LLM proxy. The sandbox's OPENAI_API_KEY is the session's rt_* token
   * (NOT the real key); the proxy verifies the token and swaps it for
   * the real OPENAI_API_KEY before forwarding to api.openai.com.
   * Omit for local/non-sandboxed runs where the real key lives in env.
   */
  proxy?: CodexProxyConfig;
}): string {
  // Top-level (root-table) keys MUST come before any [section] header.
  // TOML tables extend until the next bracketed header, so a `model_provider`
  // line emitted after `[model_providers.cogniplane_proxy]` would become
  // `model_providers.cogniplane_proxy.model_provider` and Codex would never
  // see the selector. Keep all root-scoped keys grouped here at the top.
  const lines = [
    "# Auto-generated for Cogniplane E2B runtime",
    `model = "${input.model}"`,
    'tool_output_token_limit = 25000'
  ];
  if (input.proxy) {
    lines.push('model_provider = "cogniplane_proxy"');
  }
  lines.push("");

  if (input.proxy) {
    // `wire_api = "responses"` matches Codex's default model surface
    // (gpt-5.x via the Responses API). `env_key` tells Codex which env
    // var holds the bearer token — we put the rt_* there.
    lines.push(
      "[model_providers.cogniplane_proxy]",
      'name = "Cogniplane Proxy"',
      `base_url = "${input.proxy.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      ""
    );
  }

  lines.push(
    "[features]",
    "unified_exec = true",
    "apply_patch_freeform = true",
    "skills = true",
    "shell_snapshot = false",
    "",
    `[projects."${input.workspaceRoot}"]`,
    'trust_level = "trusted"',
    ""
  );

  if (input.mcpServersToml) {
    lines.push(input.mcpServersToml);
  }

  return lines.join("\n");
}

export function buildCodexStdioCommand(binaryPath: string): string {
  return `${binaryPath} app-server --listen stdio://`;
}

/**
 * Extracts all `[mcp_servers.*]` sections (including nested `.headers`) from a
 * TOML string. Used to merge workspace-level MCP config into the sandbox-global
 * `~/.codex/config.toml`.
 */
export function extractMcpServersToml(toml: string): string {
  const lines = toml.split("\n");
  const mcpLines: string[] = [];
  let inMcpSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[mcp_servers[\].]/.test(trimmed)) {
      inMcpSection = true;
      mcpLines.push(line);
    } else if (inMcpSection) {
      if (/^\[(?!mcp_servers)/.test(trimmed)) {
        inMcpSection = false;
      } else {
        mcpLines.push(line);
      }
    }
  }

  return mcpLines.join("\n").trim();
}
