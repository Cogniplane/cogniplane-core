import type { Options, WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeApprovalHandler } from "./claude-code-approval-handler.js";
import type { E2bClaudeRuntimeProcess } from "../runtime/e2b-claude-runtime-process.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";

export type ClaudeWarmState = {
  query: WarmQuery;
  /** Default model the subprocess was started with. */
  model: string;
};

export type ClaudeCodeE2bOptions = {
  apiKey: string;
  templateId: string;
  sandboxTimeoutMs: number;
};

export type ClaudeMcpServerEntry = {
  id: string;
  url: string;
};

export type ClaudeSessionState = {
  sessionId: string;
  tenantId: string;
  userId: string;
  runtimeId: string;
  /**
   * For `local` mode: absolute path under RUNTIME_WORKSPACE_ROOT on the backend.
   * For `e2b` mode: the in-sandbox path (e.g. /home/user/workspace/<sessionId>).
   */
  workspacePath: string;
  /** Only set in `e2b` mode — where local staging files live pending upload. Cleaned up on abort. */
  localStagingPath: string | null;
  configBundle: RuntimeConfigBundle;
  approvalHandler: ClaudeApprovalHandler;
  abortController: AbortController;
  claudeSessionId: string | null;
  anthropicApiKey: string | null;
  runtimeToken: string;
  /** Backend /llm/anthropic proxy URL. The SDK calls this in both local
   *  and e2b mode; the proxy verifies the rt_* token and forwards to
   *  api.anthropic.com after swapping it for the real key. Captures token
   *  usage + cost to the assistant message on the way through. */
  proxyBaseUrl: string;
  mcpServerEntries: ClaudeMcpServerEntry[];
  mode: "local" | "e2b";
  /** Long-lived stdio bridge to the in-sandbox harness. Only set in `e2b` mode. */
  e2bProcess: E2bClaudeRuntimeProcess | null;
  /**
   * Mutable delegate for the per-turn `canUseTool` handler. The `startup()`
   * warmup options hold a stable closure that reads from this ref, so turns
   * can swap the actual handler without rebuilding the pre-warmed subprocess.
   * Local mode only; always null in e2b mode.
   */
  warmCanUseToolRef: { current: NonNullable<Options["canUseTool"]> | null };
  /**
   * Promise that resolves to the pre-warmed CLI subprocess handle (or null if
   * warmup failed). Consumed and set to null after the first turn. Local mode
   * only; always null in e2b mode.
   */
  warmState: Promise<ClaudeWarmState | null> | null;
  /**
   * Hook the runtime adapter calls to stop the in-flight turn while keeping
   * the session warm (Stop button). Set at turn start, cleared at turn end.
   * In `local` mode `interrupt` captures the SDK iterator's `.interrupt()`.
   * In `e2b` mode it sends an `interrupt` protocol frame to the harness,
   * which calls `iterator.interrupt()` inside the sandbox. Either way the
   * SDK eventually emits a `result` of subtype="interrupt" which the event
   * mapper translates into the terminal `response.completed { interrupted }`.
   */
  activeTurnInterrupt: { current: (() => Promise<void>) | null };
};
