import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Options, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeReasoningEffort, RuntimeSessionRef, RuntimeUserInput } from "../../runtime-contracts.js";
import { buildTurnInputs } from "../runtime/runtime-turn-inputs.js";

// Allowlist of env vars allowed to reach the Claude SDK subprocess / E2B
// sandbox harness. EVERYTHING ELSE in process.env is dropped.
//
// We deliberately use an allowlist (not a denylist): the backend process holds
// many secrets (DATABASE_URL, JWT_SECRET, WORKOS_*, GITHUB/NOTION OAuth client
// secrets, PII_* keys, ARTIFACT_BUCKET_* AWS creds, PII_RETENTION_KEK, …) and
// new ones land here every time config.ts grows. A denylist is fail-open — a
// freshly-added secret leaks until someone remembers to add it — which is
// exactly how NOTION_OAUTH_CLIENT_SECRET ended up reachable by the agent. An
// allowlist is fail-closed: a new backend secret is excluded by default.
//
// The members below are the env vars the Claude Agent SDK / Claude Code CLI
// actually reads (verified against the installed @anthropic-ai/claude-agent-sdk
// build), plus the baseline OS vars a Node subprocess needs to run, plus the
// standard proxy / TLS knobs an operator behind a corporate egress would set.
// ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL are NOT inherited — buildClaudeSdkEnv
// sets them explicitly (proxy rt_* token or fallback key) after filtering.
//
// To preserve operator customization without re-opening the fail-open hole,
// matching is by exact name OR by one of CLAUDE_SDK_ENV_ALLOW_PREFIXES — both
// scoped to namespaces the SDK owns (no backend secret uses these prefixes).

const CLAUDE_SDK_ENV_ALLOW_PREFIXES = [
  // The Claude Code CLI reads a wide, evolving range of CLAUDE_CODE_* knobs
  // (cert store / client cert, Bedrock/Vertex routing, OAuth URLs, debug,
  // worker tuning). No backend secret uses this prefix.
  "CLAUDE_CODE_",
  // Locale vars (LC_ALL, LC_CTYPE, …) — purely cosmetic, never secret-bearing.
  "LC_"
];

const CLAUDE_SDK_ENV_ALLOW_NAMES = new Set<string>([
  // ── Anthropic API routing the SDK reads. ALL auth is set explicitly by
  //    buildClaudeSdkEnv (the proxy rt_* token, or the fallback key), so the
  //    credential-bearing vars are intentionally absent here:
  //      - ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL (set explicitly)
  //      - ANTHROPIC_AUTH_TOKEN (a bearer/OAuth credential — inheriting it
  //        would both leak a real provider credential into the sandbox AND let
  //        the SDK bypass the rt_* proxy in proxy mode)
  //      - ANTHROPIC_CUSTOM_HEADERS (can carry an `Authorization:` header)
  //    Only non-secret routing/config knobs stay on the allowlist. ──
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_LOG",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_PROFILE",
  // The SDK reads CLAUDE_AGENT_SDK_VERSION for its User-Agent / telemetry. Since
  // 0.3.149 corrected `options.env` to *replace* (not merge into) the subprocess
  // env, an allowlist that omits this drops the version from the User-Agent. Not
  // a secret; keep it on the allowlist so diagnostics stay accurate.
  "CLAUDE_AGENT_SDK_VERSION",
  // ── Bedrock / Vertex / cloud-provider routing the CLI honors. ──
  "CLAUDE_CONFIG_DIR",
  // ── Standard proxy / TLS knobs for corporate egress. ──
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  // ── Node runtime knobs needed by the spawned CLI / harness. ──
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // ── Baseline OS environment a subprocess needs to run. ──
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "USERPROFILE",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SYSTEMROOT",
  "WINDIR"
]);

export function isClaudeSdkEnvAllowed(key: string): boolean {
  return (
    CLAUDE_SDK_ENV_ALLOW_NAMES.has(key) ||
    CLAUDE_SDK_ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Resolves the multi-modal turn inputs into an array of Claude SDK content
 * blocks. Shared by the local-SDK prompt stream builder and the E2B turn
 * builder so both paths attach image artifacts identically.
 */
export async function buildClaudeContentBlocks(input: {
  prompt: string;
  userInputs?: RuntimeUserInput[];
  runtimePolicy: RuntimeSessionRef["runtimePolicy"];
  toolContextId: string | null;
}): Promise<Array<Record<string, unknown>>> {
  const turnInputs = buildTurnInputs(input);
  const contentBlocks: Array<Record<string, unknown>> = [];

  for (const entry of turnInputs) {
    if (entry.type === "text") {
      contentBlocks.push({ type: "text", text: entry.text });
      continue;
    }

    if (entry.type === "image") {
      contentBlocks.push({
        type: "text",
        text: `Remote image URL provided for this turn: ${entry.url}`
      });
      continue;
    }

    const mediaType = inferImageMediaType(entry.path);
    const encoded = await readFile(entry.path, "base64");
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: encoded }
    });
  }

  return contentBlocks;
}

export function buildClaudePromptStream(input: {
  prompt: string;
  userInputs?: RuntimeUserInput[];
  runtimePolicy: RuntimeSessionRef["runtimePolicy"];
  toolContextId: string | null;
  sessionId: string;
}): AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage> {
  return (async function* () {
    const contentBlocks = await buildClaudeContentBlocks(input);

    const message = {
      role: "user",
      content: contentBlocks
    } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKUserMessage["message"];

    yield {
      type: "user",
      session_id: input.sessionId,
      message,
      parent_tool_use_id: null
    };
  })();
}

export type ClaudeSdkHttpMcpServerConfig = {
  type: "http";
  url: string;
  headers: Record<string, string>;
};

/**
 * Builds the SDK `mcpServers` map for a Claude session: one HTTP entry per
 * managed/proxy server, each authenticated with the session's short-lived rt_*
 * token.
 *
 * We deliberately do NOT set the SDK's `alwaysLoad` flag. As of
 * @anthropic-ai/claude-agent-sdk 0.3.142 MCP startup is non-blocking by default;
 * `alwaysLoad: true` would force a `tools/list` during `startup()` (session
 * warmup) — which runs before the per-turn `ToolExecutionContext` exists — and
 * the MCP gateway falls back to advertising EVERY managed tool when no active
 * turn context is present, leaking tools the tenant's policy disables into the
 * warm subprocess's cached tool list. Non-blocking startup is acceptable here:
 * managed tools are used reactively (after the model's first response), the SDK
 * reports slow servers as `pending` and connects them within the standard 5s,
 * and the warm pre-spawn gives the connection idle time before the first turn.
 */
export function buildClaudeMcpServersConfig(
  servers: ReadonlyArray<{ id: string; url: string }>,
  runtimeToken: string
): Record<string, ClaudeSdkHttpMcpServerConfig> {
  const mcpServersConfig: Record<string, ClaudeSdkHttpMcpServerConfig> = {};
  for (const server of servers) {
    mcpServersConfig[server.id] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${runtimeToken}` }
    };
  }
  return mcpServersConfig;
}

export function buildClaudeSdkOptions(input: {
  model: string;
  effort?: RuntimeReasoningEffort;
  developerInstructions: string | null;
  mcpServersConfig: Record<string, ClaudeSdkHttpMcpServerConfig>;
  workspacePath: string;
  env: Record<string, string | undefined>;
  canUseTool: NonNullable<Options["canUseTool"]>;
}): Options {
  const systemPrompt: Options["systemPrompt"] =
    input.developerInstructions
      ? { type: "preset", preset: "claude_code", append: input.developerInstructions }
      : { type: "preset", preset: "claude_code" };

  return {
    model: input.model,
    maxTurns: 100,
    ...(input.effort
      ? {
          thinking: { type: "adaptive" as const },
          effort: input.effort as import("@anthropic-ai/claude-agent-sdk").EffortLevel
        }
      : {}),
    systemPrompt,
    tools: { type: "preset", preset: "claude_code" },
    // Required for tool visibility in our UI. Without partial messages,
    // the SDK withholds stream_event frames, which means we never see
    // tool_use starts for Bash/MCP/native tools and the frontend cannot
    // render the in-flight tool rows.
    includePartialMessages: true,
    ...(Object.keys(input.mcpServersConfig).length > 0 ? { mcpServers: input.mcpServersConfig } : {}),
    // Always "default" — we never want the SDK to short-circuit
    // canUseTool, because that's our only hook for injecting
    // toolContextId into MCP calls. "Bypass" is handled inside the
    // approval handler instead (state.approvalHandler.setBypass),
    // which still returns {behavior: "allow"} but routes through
    // enrichInput() first.
    permissionMode: "default",
    settingSources: ["project"],
    cwd: input.workspacePath,
    env: input.env,
    canUseTool: input.canUseTool
  };
}

/**
 * Builds the env handed to the Claude Agent SDK.
 *
 * Both local and e2b modes route through the backend's /llm/anthropic
 * proxy: `proxy.runtimeToken` is the session's short-lived rt_* token and
 * `proxy.baseUrl` is the proxy URL. The proxy verifies the rt_*, swaps it
 * for the real ANTHROPIC_API_KEY (per-tenant or platform-default), and
 * forwards to api.anthropic.com. Routing through the proxy in both modes
 * gives one place where token usage + cost are captured and persisted to
 * the assistant message (see llm-proxy-core.ts → activeTurnMessageMap).
 *
 * `anthropicApiKey` is only used as a fallback when no proxy is supplied
 * (e.g. an out-of-band caller or a future provider that doesn't go through
 * the proxy). Normal request paths always pass `proxy`.
 */
export function buildClaudeSdkEnv(
  anthropicApiKey: string | null,
  proxy?: { runtimeToken: string; baseUrl: string }
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isClaudeSdkEnvAllowed(key)) {
      continue;
    }
    env[key] = value;
  }
  if (proxy) {
    env.ANTHROPIC_API_KEY = proxy.runtimeToken;
    env.ANTHROPIC_BASE_URL = proxy.baseUrl;
  } else if (anthropicApiKey) {
    env.ANTHROPIC_API_KEY = anthropicApiKey;
  } else {
    // If we don't have a key of our own, don't leak an inherited one either —
    // the SDK will error cleanly and the caller's capability check upstream
    // already prevents this path when no key is available.
    delete env.ANTHROPIC_API_KEY;
  }
  // Suppress the SDK's built-in auto session-title generation. We run our own
  // titler in routes/messages.ts via session-titler.ts; without this, the
  // spawned CLI subprocess makes a redundant Haiku-class title call per session.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export function inferImageMediaType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  const resolvedPath = path.resolve(workspacePath, filePath);
  const workspaceRoot = workspacePath.endsWith(path.sep) ? workspacePath : workspacePath + path.sep;

  if (!resolvedPath.startsWith(workspaceRoot) && resolvedPath !== workspacePath) {
    throw new Error("filePath must be inside the session workspace.");
  }

  return resolvedPath;
}

/**
 * Resolves a relative path inside the E2B sandbox's workspace. Uses POSIX
 * semantics regardless of the backend's OS, since sandbox paths are always
 * Linux-style. Guards against directory traversal so callers cannot escape
 * the sandbox workspace.
 */
export function resolveSandboxWorkspacePath(sandboxWorkspacePath: string, filePath: string): string {
  const resolvedPath = path.posix.resolve(sandboxWorkspacePath, filePath);
  const workspaceRoot = sandboxWorkspacePath.endsWith("/")
    ? sandboxWorkspacePath
    : sandboxWorkspacePath + "/";

  if (!resolvedPath.startsWith(workspaceRoot) && resolvedPath !== sandboxWorkspacePath) {
    throw new Error("filePath must be inside the session workspace.");
  }

  return resolvedPath;
}

// ── SDK message type guards ───────────────────────────────────────────────────

export function isInitMessage(m: unknown): m is SDKSystemMessage {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as Record<string, unknown>)["type"] === "system" &&
    (m as Record<string, unknown>)["subtype"] === "init"
  );
}

