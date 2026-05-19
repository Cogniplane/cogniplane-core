import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Options, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeReasoningEffort, RuntimeSessionRef, RuntimeUserInput } from "../../runtime-contracts.js";
import { buildTurnInputs } from "../runtime/runtime-turn-inputs.js";

// Backend-only secrets that must never reach the Claude SDK subprocess.
// Anything whose name contains one of these substrings is stripped.
// The denylist approach (vs an allowlist) preserves legitimate operator
// customization — corporate proxies, Bedrock/Vertex routing, custom model
// env vars — which the Claude CLI consumes under a wide range of names.
export const CLAUDE_SDK_ENV_DENY_SUBSTRINGS = [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "JWT_SECRET",
  "DATA_ENCRYPTION_SECRET",
  "WORKOS_",
  "GITHUB_OAUTH_",
  "PII_OPENROUTER_API_KEY",
  "E2B_API_KEY",
  "ARTIFACT_BUCKET_ACCESS_KEY_ID",
  "ARTIFACT_BUCKET_SECRET_ACCESS_KEY",
  "ARTIFACT_BUCKET_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "REDIS_URL"
];

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

type ClaudeSdkHttpMcpServerConfig = {
  type: "http";
  url: string;
  headers: Record<string, string>;
};

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
    if (CLAUDE_SDK_ENV_DENY_SUBSTRINGS.some((needle) => key.includes(needle))) {
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

