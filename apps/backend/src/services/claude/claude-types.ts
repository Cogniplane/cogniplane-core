import type { E2bClaudeRuntimeProcess } from "../runtime/e2b-claude-runtime-process.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import type { RuntimeEvent } from "../../runtime-contracts.js";

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
  /** The in-sandbox workspace path (e.g. /home/user/workspace/<sessionId>). */
  workspacePath: string;
  /** Local staging dir where workspace files live pending upload to the sandbox. Cleaned up on abort. */
  localStagingPath: string;
  configBundle: RuntimeConfigBundle;
  abortController: AbortController;
  claudeSessionId: string | null;
  anthropicApiKey: string | null;
  runtimeToken: string;
  /** Backend /llm/anthropic proxy URL. The SDK (inside the sandbox) calls this;
   *  the proxy verifies the rt_* token and forwards to api.anthropic.com after
   *  swapping it for the real key. Captures token usage + cost to the assistant
   *  message on the way through. */
  proxyBaseUrl: string;
  mcpServerEntries: ClaudeMcpServerEntry[];
  /** Long-lived stdio bridge to the in-sandbox harness. */
  e2bProcess: E2bClaudeRuntimeProcess;
  /**
   * Hook the runtime adapter calls to stop the in-flight turn while keeping
   * the session warm (Stop button). Set at turn start, cleared at turn end.
   * Sends an `interrupt` protocol frame to the harness, which calls
   * `iterator.interrupt()` inside the sandbox; the SDK then emits a `result`
   * of subtype="interrupt" which the event mapper translates into the terminal
   * `response.completed { interrupted }`.
   */
  activeTurnInterrupt: { current: (() => Promise<void>) | null };
  /**
   * Hook to push a framework event onto the in-flight turn's SSE event queue.
   * Set at turn start, cleared at turn end. Used by the Policy Center approval
   * coordinator (gateway-held tool-call approvals) to surface
   * `framework:approval_required` / reminder notices on the active turn. Null
   * when no turn is running.
   */
  activeTurnPush: { current: ((event: RuntimeEvent) => void) | null };
};
