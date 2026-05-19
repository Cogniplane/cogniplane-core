import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";

import type {
  JsonRpcNotification,
  JsonRpcRequest
} from "./codex-runtime-process.js";
import { CodexRuntimeProcessStartError } from "./codex-runtime-process.js";
import {
  buildCodexStdioCommand,
  buildSandboxCodexConfig,
  extractMcpServersToml
} from "./e2b-codex-mcp-config.js";
import { createRuntimeWorkspace } from "./runtime-workspace.js";
import type { RuntimeProcessFactory, RuntimeWorkspaceFactory } from "./runtime-types.js";

type JsonRpcSuccess = {
  id: number | string;
  result: unknown;
};

type JsonRpcFailure = {
  id: number | string;
  error: {
    code: number;
    message: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type E2bCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type E2bCommandHandle = {
  pid: number;
  exitCode: number | undefined;
  error?: string;
  stdout: string;
  stderr: string;
  wait: () => Promise<E2bCommandResult>;
  kill: () => Promise<boolean>;
};

// Structural subset of the E2B SDK's Sandbox class (e2b@^2.19).
// Kept in sync manually — verify against the SDK when upgrading e2b.
type E2bSandboxLike = {
  sandboxId: string;
  files: {
    write: (files: Array<{ path: string; data: string | ArrayBuffer }>) => Promise<void>;
    read: (path: string, opts: { format: "bytes" }) => Promise<Uint8Array>;
  };
  commands: {
    run: (
      command: string,
      options?: {
        background?: boolean;
        stdin?: boolean;
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      }
    ) => Promise<
      | E2bCommandHandle
      | E2bCommandResult
    >;
    sendStdin: (pid: number, data: string) => Promise<void>;
    list: () => Promise<Array<{ pid: number; cmd: string }>>;
  };
  kill: () => Promise<void>;
};

const E2B_WORKSPACE_BASE = "/home/user/workspace";
const E2B_CODEX_HOME = "/home/user/.codex";

/**
 * E2B runtime process adapter using Codex app-server's default stdio transport.
 *
 * This keeps the transport aligned with the documented Codex default and uses
 * E2B's native stdin/stdout support directly, avoiding an extra bridge layer.
 */
export class E2bRuntimeProcess {
  private requestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<(request: JsonRpcRequest) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private alive = true;
  // stdout line buffering and process-exit watching live in startE2bStdioHarness;
  // this class only handles JSON-RPC semantics on already-parsed lines.
  private logger: FastifyBaseLogger | null = null;

  private constructor(
    readonly port: number,
    private readonly sandbox: E2bSandboxLike,
    private processPid: number,
    private readonly requestTimeoutMs: number,
    readonly sandboxId: string
  ) {}

  static async start(input: {
    binaryPath: string;
    cwd: string;
    logger: FastifyBaseLogger;
    requestTimeoutMs: number;
    startTimeoutMs: number;
    runtimeId: string;
    sessionId: string;
    env?: Record<string, string>;
    e2bApiKey: string;
    e2bTemplateId: string;
    e2bSandboxTimeoutMs: number;
    localWorkspacePath: string;
    model: string;
    /**
     * When set, configure Codex to route model calls through the backend
     * LLM proxy at this URL. `input.env.OPENAI_API_KEY` must be a rt_*
     * runtime token (NOT the real OpenAI key) — the proxy verifies it
     * and swaps for the real key before forwarding upstream. Caller is
     * responsible for the env swap; this method only renders the config.
     */
    proxyBaseUrl?: string;
  }): Promise<E2bRuntimeProcess> {
    const sandboxCwd = input.cwd;
    const codexConfig = await buildCodexConfigForSandbox({
      localWorkspacePath: input.localWorkspacePath,
      sandboxCwd,
      model: input.model,
      ...(input.proxyBaseUrl ? { proxyBaseUrl: input.proxyBaseUrl } : {})
    });

    // Late-bound closure: the harness's onStdoutLine/onExit callbacks are
    // registered synchronously inside `startE2bStdioHarness`, but no stdout
    // or exit event can fire until the background process has actually
    // started — which happens strictly AFTER this `await` resolves. By that
    // point `proc` is assigned, so every callback sees a real instance.
    let proc: E2bRuntimeProcess | null = null;
    try {
      const harness = await startE2bStdioHarness({
        logger: input.logger,
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        e2bApiKey: input.e2bApiKey,
        e2bTemplateId: input.e2bTemplateId,
        e2bSandboxTimeoutMs: input.e2bSandboxTimeoutMs,
        env: input.env,
        localWorkspacePath: input.localWorkspacePath,
        sandboxWorkspacePath: sandboxCwd,
        command: buildCodexStdioCommand(input.binaryPath),
        stderrLogLabel: "Codex runtime (E2B)",
        preLaunch: async (sandbox) => {
          await installCodexConfigInSandbox(sandbox, sandboxCwd, codexConfig);
          // Skip `codex login --with-api-key` when using the cogniplane
          // proxy: the rt_* token doesn't match Codex's sk-... format
          // validator, and the custom model_provider reads OPENAI_API_KEY
          // straight from env (env_key in config.toml). Local-only mode
          // still needs login so Codex writes to ~/.codex/auth.json the
          // way the built-in OpenAI provider expects.
          const apiKey = input.env?.OPENAI_API_KEY;
          if (input.env && apiKey && !apiKey.startsWith("rt_")) {
            await loginCodexCli({
              sandbox,
              sandboxCwd,
              env: input.env,
              binaryPath: input.binaryPath,
              sessionId: input.sessionId,
              logger: input.logger
            });
          }
        },
        onStdoutLine: (line) => proc?.dispatchStdoutLine(line),
        onExit: (result) => proc?.handleHarnessExit(result)
      });

      proc = new E2bRuntimeProcess(
        0,
        harness.sandbox,
        harness.processPid,
        input.requestTimeoutMs,
        harness.sandbox.sandboxId
      );
      proc.logger = input.logger;
      return proc;
    } catch (error) {
      throw new CodexRuntimeProcessStartError(
        error instanceof Error ? error.message : "E2B sandbox startup failed",
        0,
        null
      );
    }
  }

  /**
   * Unexpected-exit hook called by the harness's exit watcher. Idempotent —
   * if the proc is already torn down, do nothing. Otherwise, mark dead, fire
   * close/exit listeners, and reject every pending JSON-RPC request so
   * callers stop awaiting forever.
   */
  private handleHarnessExit(result: E2bStdioHarnessExitResult): void {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.closeListeners) listener();
    for (const listener of this.exitListeners) listener(result.exitCode ?? null, null);
    this.rejectPendingRequests(
      `E2B Codex app-server exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`
    );
  }

  /**
   * Dispatches a single newline-delimited JSON-RPC line from the harness.
   * Line-buffering happens in `startE2bStdioHarness`; this method is safe
   * to call with partial lines (they'll simply fail JSON.parse and be
   * silently dropped).
   */
  private dispatchStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let incomingMessage: JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
    try {
      incomingMessage = JSON.parse(trimmed) as
        | JsonRpcRequest
        | JsonRpcSuccess
        | JsonRpcFailure
        | JsonRpcNotification;
    } catch {
      return; // Not valid JSON — ignore
    }

    // JSON-RPC discriminators:
    //   request:      has both `method` and `id`
    //   notification: has `method`, no `id`
    //   response:     has `id`, no `method` (success carries `result`, failure carries `error`)
    if ("method" in incomingMessage && "id" in incomingMessage) {
      this.handleJsonRpcRequest(incomingMessage as JsonRpcRequest);
    } else if ("id" in incomingMessage) {
      this.handleJsonRpcResponse(incomingMessage as JsonRpcSuccess | JsonRpcFailure);
    } else {
      this.handleJsonRpcNotification(incomingMessage as JsonRpcNotification);
    }
  }

  private handleJsonRpcRequest(request: JsonRpcRequest): void {
    for (const listener of this.requestListeners) listener(request);
  }

  private handleJsonRpcResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    if ("error" in response) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleJsonRpcNotification(notification: JsonRpcNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  private sendLine(json: string): void {
    this.sandbox.commands.sendStdin(this.processPid, json + "\n").catch((err) => {
      if (!this.alive) return;
      this.alive = false;

      // The harness's exit watcher (see startE2bStdioHarness) is the
      // authoritative source of stderr/exitCode diagnostics — it fires
      // in parallel with this failure. Here we just fail fast so pending
      // requests don't hang waiting for a dead process.
      this.logger?.error(
        {
          sandboxId: this.sandboxId,
          pid: this.processPid,
          error: err instanceof Error ? err.message : String(err)
        },
        "E2B sendStdin failed — Codex process is gone"
      );

      for (const listener of this.closeListeners) listener();
      this.rejectPendingRequests(
        `E2B Codex app-server exited: ${err instanceof Error ? err.message : "unknown error"}`
      );
    });
  }

  get pid(): number | null {
    return null;
  }

  get socketReadyState(): number {
    return this.alive ? WebSocket.OPEN : WebSocket.CLOSED;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.requestId++;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method} response (E2B).`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    this.sendLine(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  sendResponse(id: number | string, result: unknown): void {
    this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  sendError(id: number | string, code: number, message: string): void {
    this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    return this.sandbox.files.read(filePath, { format: "bytes" });
  }

  async writeFile(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<void> {
    // E2B SDK expects string | ArrayBuffer. Convert Uint8Array (including Buffer)
    // to a properly sliced ArrayBuffer to avoid pooled-buffer corruption.
    let payload: string | ArrayBuffer;
    if (typeof data === "string") {
      payload = data;
    } else if (data instanceof Uint8Array) {
      payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else {
      payload = data;
    }
    await this.sandbox.files.write([{ path: filePath, data: payload }]);
  }

  closeSocket(): void {
    this.alive = false;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  terminate(): void {
    this.alive = false;
    void this.sandbox.kill().catch((err: unknown) => {
      this.logger?.warn(
        { err, sandboxId: this.sandbox.sandboxId },
        "E2B sandbox kill failed during terminate"
      );
    });
    for (const listener of this.exitListeners) {
      listener(null, null);
    }
  }

  rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: JsonRpcRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

export {
  buildCodexStdioCommand,
  buildSandboxCodexConfig,
  buildE2bCodexFactories,
  extractMcpServersToml,
  E2B_WORKSPACE_BASE,
  remapEnvPathsToSandbox,
  startE2bStdioHarness,
  loadE2bSandboxClass
};
export type { E2bSandboxLike, E2bStdioHarness, E2bStdioHarnessExitResult, E2bStdioHarnessInput };

/**
 * Rewrites env var values that reference the local workspace path so they
 * resolve to the sandbox-internal path instead.
 *
 * Example: `GIT_CONFIG_GLOBAL=/tmp/.../session-1/.sandbox/github/gitconfig`
 * becomes `/home/user/workspace/session-1/.sandbox/github/gitconfig`.
 */
function remapEnvPathsToSandbox(
  env: Record<string, string> | undefined,
  localPath: string,
  sandboxPath: string
): Record<string, string> | undefined {
  if (!env) return undefined;
  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    remapped[key] = value.includes(localPath) ? value.replaceAll(localPath, sandboxPath) : value;
  }
  return remapped;
}

/**
 * Paired workspace + process factories for the E2B backend of the Codex
 * runtime. The workspace factory stages files locally via
 * `createRuntimeWorkspace`; the process factory uploads them to the sandbox,
 * starts codex, and cleans up the staging dir.
 */
function buildE2bCodexFactories(config: AppConfig): {
  processFactory: RuntimeProcessFactory;
  workspaceFactory: RuntimeWorkspaceFactory;
} {
  const workspaceFactory: RuntimeWorkspaceFactory = async (appConfig, input) => {
    const workspace = await createRuntimeWorkspace(appConfig, input);
    const sandboxWorkspacePath = path.posix.join(E2B_WORKSPACE_BASE, input.sessionId);
    return {
      workspacePath: sandboxWorkspacePath,
      localWorkspacePath: workspace.workspacePath,
      codexTomlPath: path.posix.join(sandboxWorkspacePath, "codex.toml"),
      manifestPath: path.posix.join(sandboxWorkspacePath, ".framework", "runtime-manifest.json"),
      manifest: workspace.manifest,
      runtimeToken: workspace.runtimeToken
    };
  };

  const processFactory: RuntimeProcessFactory = async (input) => {
    const localPath = input.localWorkspacePath;
    if (!localPath) {
      throw new Error(`No local workspace path was provided for session ${input.sessionId}.`);
    }
    const remappedEnv = remapEnvPathsToSandbox(input.env, localPath, input.cwd);
    // In e2b mode the sandbox routes model calls through the backend's
    // /llm/openai proxy. The sandbox's OPENAI_API_KEY is the session's
    // rt_* token (set by codex-workspace-bootstrap); the proxy verifies it
    // and swaps for the real key before forwarding to api.openai.com.
    const proxyBaseUrl = `${config.RUNTIME_GATEWAY_BASE_URL.replace(/\/$/, "")}/llm/openai/v1`;
    try {
      // start() awaits the full file upload to the sandbox before returning,
      // so the local staging directory is safe to remove in the finally block.
      return await E2bRuntimeProcess.start({
        binaryPath: input.binaryPath,
        cwd: input.cwd,
        logger: input.logger,
        requestTimeoutMs: input.requestTimeoutMs,
        startTimeoutMs: input.startTimeoutMs,
        runtimeId: input.runtimeId,
        sessionId: input.sessionId,
        env: remappedEnv,
        e2bApiKey: config.E2B_API_KEY!,
        e2bTemplateId: config.E2B_TEMPLATE_ID,
        e2bSandboxTimeoutMs: config.E2B_SANDBOX_TIMEOUT_MS,
        localWorkspacePath: localPath,
        model: config.CODEX_MODEL,
        proxyBaseUrl
      });
    } finally {
      rm(localPath, { recursive: true, force: true }).catch((err: unknown) => {
        input.logger.warn(
          { err, sessionId: input.sessionId, runtimeId: input.runtimeId, localPath },
          "failed to clean up local workspace staging dir"
        );
      });
    }
  };

  return { processFactory, workspaceFactory };
}

// ---------------------------------------------------------------------------
// Codex-specific sandbox setup helpers
// ---------------------------------------------------------------------------

/**
 * Pre-read the workspace `codex.toml` and merge its `[mcp_servers.*]`
 * sections into the global `~/.codex/config.toml` we'll install in the
 * sandbox. Codex app-server in some versions ignores those sections from
 * project-level codex.toml, so we duplicate them globally to guarantee
 * MCP-server discovery.
 */
async function buildCodexConfigForSandbox(input: {
  localWorkspacePath: string;
  sandboxCwd: string;
  model: string;
  proxyBaseUrl?: string;
}): Promise<string> {
  const files = await collectLocalWorkspaceFiles(input.localWorkspacePath);
  const workspaceToml = files.find((f) => f.relativePath === "codex.toml");
  const mcpTomlSection = workspaceToml
    ? extractMcpServersToml(
        typeof workspaceToml.data === "string"
          ? workspaceToml.data
          : new TextDecoder().decode(workspaceToml.data)
      )
    : "";
  return buildSandboxCodexConfig({
    model: input.model,
    workspaceRoot: path.posix.dirname(input.sandboxCwd),
    mcpServersToml: mcpTomlSection,
    ...(input.proxyBaseUrl ? { proxy: { baseUrl: input.proxyBaseUrl } } : {})
  });
}

/**
 * Reset and install `~/.codex/config.toml` inside the sandbox. The `rm` of
 * `auth.json` and the previous `config.toml` ensures we start from a known
 * state — sandboxes can be reused or restarted, and stale auth/config from
 * a previous tenant or model must not leak into the next session.
 */
async function installCodexConfigInSandbox(
  sandbox: E2bSandboxLike,
  sandboxCwd: string,
  codexConfig: string
): Promise<void> {
  await sandbox.commands.run(
    `mkdir -p ${E2B_CODEX_HOME} && rm -f ${E2B_CODEX_HOME}/auth.json ${E2B_CODEX_HOME}/config.toml`,
    { cwd: sandboxCwd }
  );
  await sandbox.files.write([{ path: `${E2B_CODEX_HOME}/config.toml`, data: codexConfig }]);
}

/**
 * Run `codex login --with-api-key` inside the sandbox using the tenant's
 * OPENAI_API_KEY. Throws on non-zero exit so the harness rolls back the
 * sandbox creation instead of starting a process that will fail on the
 * first model call.
 */
async function loginCodexCli(input: {
  sandbox: E2bSandboxLike;
  sandboxCwd: string;
  env: Record<string, string>;
  binaryPath: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const loginResult = await input.sandbox.commands.run(
    `printf '%s' "$OPENAI_API_KEY" | ${input.binaryPath} login --with-api-key >/dev/null`,
    { cwd: input.sandboxCwd, envs: input.env, timeoutMs: 30_000 }
  );
  if (!isE2bCommandResult(loginResult)) {
    throw new Error("E2B did not return a foreground command result for Codex login.");
  }
  if (loginResult.exitCode !== 0) {
    input.logger.error(
      { sessionId: input.sessionId, stderr: loginResult.stderr.trim() },
      "Codex API-key login failed in E2B sandbox"
    );
    throw new Error("Codex API-key login failed in E2B sandbox.");
  }
}

// ---------------------------------------------------------------------------
// Shared stdio harness
// ---------------------------------------------------------------------------

type E2bStdioHarness = {
  sandbox: E2bSandboxLike;
  processPid: number;
};

type E2bStdioHarnessExitResult = {
  exitCode: number | undefined;
  stderr?: string;
  stdout?: string;
  error?: string;
};

type E2bStdioHarnessInput = {
  logger: FastifyBaseLogger;
  sessionId: string;
  runtimeId: string;
  e2bApiKey: string;
  e2bTemplateId: string;
  e2bSandboxTimeoutMs: number;
  /** Env map passed to both `Sandbox.create(envs: …)` and the background command. */
  env?: Record<string, string>;
  /** Metadata surfaced in the E2B dashboard (provider, sessionId, etc.). */
  metadata?: Record<string, string>;
  /** Local staging dir uploaded before launching the command. Skipped when empty. */
  localWorkspacePath: string;
  /** Sandbox-visible workspace path. Also the cwd of the background command. */
  sandboxWorkspacePath: string;
  /** Shell command launched in the background with stdin enabled. */
  command: string;
  /** Receives each complete newline-delimited stdout line (no trailing \n). */
  onStdoutLine: (line: string) => void;
  /** Log label for stderr lines (so callers get "Codex runtime (E2B)" vs "sandbox-agent stderr"). */
  stderrLogLabel: string;
  /**
   * Optional setup step between workspace upload and the background launch.
   * Use it for provider-specific file writes or auth commands (e.g. Codex
   * login, ~/.codex/config.toml). Returning rejects surface to the caller.
   */
  preLaunch?: (sandbox: E2bSandboxLike) => Promise<void>;
  /** Unexpected-exit hook. Callers fail pending work from here. */
  onExit: (result: E2bStdioHarnessExitResult) => void;
  /** Test-only sandbox class injection. */
  loadSandboxClass?: typeof loadE2bSandboxClass;
};

/**
 * Creates an E2B sandbox, uploads the local workspace, and starts a background
 * stdio command with line-buffered stdout dispatch and an exit watcher. Used
 * by both `E2bRuntimeProcess` (Codex app-server) and `E2bClaudeRuntimeProcess`
 * (Claude sandbox-agent harness); the only per-provider difference is the
 * command string plus how the caller parses each stdout line.
 */
async function startE2bStdioHarness(input: E2bStdioHarnessInput): Promise<E2bStdioHarness> {
  const loader = input.loadSandboxClass ?? loadE2bSandboxClass;
  const Sandbox = await loader();
  const sandbox = await Sandbox.create(input.e2bTemplateId, {
    apiKey: input.e2bApiKey,
    envs: input.env ?? {},
    timeoutMs: input.e2bSandboxTimeoutMs,
    metadata: input.metadata ?? {
      runtimeId: input.runtimeId,
      sessionId: input.sessionId
    }
  });

  input.logger.info(
    { sandboxId: sandbox.sandboxId, sessionId: input.sessionId, runtimeId: input.runtimeId },
    "E2B sandbox created"
  );

  try {
    await uploadWorkspaceFiles(sandbox, input);

    if (input.preLaunch) {
      await input.preLaunch(sandbox);
    }

    const handle = await sandbox.commands.run(input.command, {
      background: true,
      stdin: true,
      cwd: input.sandboxWorkspacePath,
      envs: input.env ?? {},
      timeoutMs: 0,
      onStdout: createLineBufferedStdoutHandler(input.onStdoutLine),
      onStderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) {
          input.logger.info(
            { sessionId: input.sessionId, runtimeId: input.runtimeId, output: trimmed },
            input.stderrLogLabel
          );
        }
      }
    });

    if (!("pid" in handle) || typeof handle.pid !== "number") {
      throw new Error("E2B did not return a background command handle.");
    }

    input.logger.info(
      { sandboxId: sandbox.sandboxId, sessionId: input.sessionId, processPid: handle.pid },
      "E2B background process started"
    );

    attachExitWatcher(handle, sandbox, input);

    return { sandbox, processPid: handle.pid };
  } catch (err) {
    await sandbox.kill().catch((killErr: unknown) => {
      input.logger.warn(
        { err: killErr, sandboxId: sandbox.sandboxId, sessionId: input.sessionId },
        "E2B sandbox kill failed during startup rollback"
      );
    });
    throw err;
  }
}

/**
 * Read every file under `localWorkspacePath` and stage it into the sandbox
 * at `sandboxWorkspacePath` preserving relative paths. No-op when the local
 * directory is empty (e.g. a workspace that's still being materialized).
 */
async function uploadWorkspaceFiles(
  sandbox: E2bSandboxLike,
  input: { localWorkspacePath: string; sandboxWorkspacePath: string; sessionId: string; logger: FastifyBaseLogger }
): Promise<void> {
  const files = await collectLocalWorkspaceFiles(input.localWorkspacePath);
  if (files.length === 0) return;
  await sandbox.files.write(
    files.map((file) => ({
      path: path.posix.join(input.sandboxWorkspacePath, file.relativePath),
      data: file.data
    }))
  );
  input.logger.info(
    { sessionId: input.sessionId, fileCount: files.length },
    "Workspace files uploaded to E2B sandbox"
  );
}

/**
 * Wraps `onLine` in a chunk-to-line buffer. E2B's `onStdout` may deliver a
 * partial chunk; we accumulate, split on `\n`, and emit complete lines
 * only. The last incomplete trailing fragment stays in the buffer until
 * the next chunk arrives.
 */
function createLineBufferedStdoutHandler(onLine: (line: string) => void): (data: string) => void {
  let stdoutBuffer = "";
  return (data: string) => {
    stdoutBuffer += data;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line) onLine(line);
    }
  };
}

/**
 * Attach an exit watcher to the background command handle. Fires
 * `input.onExit` exactly once with the harness exit result, plus an
 * informational log line. If the sandbox is killed externally the wait
 * promise rejects — we log and swallow, since the sandbox is gone anyway.
 */
function attachExitWatcher(
  handle: { pid: number },
  sandbox: E2bSandboxLike,
  input: E2bStdioHarnessInput
): void {
  const cmdHandle = handle as unknown as {
    wait?: () => Promise<E2bStdioHarnessExitResult>;
  };
  if (typeof cmdHandle.wait !== "function") return;

  cmdHandle.wait().then(
    (result) => {
      input.logger.error(
        {
          sandboxId: sandbox.sandboxId,
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          pid: handle.pid,
          exitCode: result.exitCode,
          stderr: result.stderr?.slice(-2000),
          stdout: result.stdout?.slice(-500),
          error: result.error
        },
        "E2B background process exited"
      );
      input.onExit(result);
    },
    (err) => {
      input.logger.warn(
        { sandboxId: sandbox.sandboxId, sessionId: input.sessionId, error: String(err) },
        "E2B CommandHandle.wait() rejected (sandbox may have been killed)"
      );
    }
  );
}

async function loadE2bSandboxClass(): Promise<{
  create: (
    templateId: string,
    options: {
      apiKey: string;
      envs?: Record<string, string>;
      timeoutMs: number;
      metadata?: Record<string, string>;
      }
    ) => Promise<E2bSandboxLike>;
}> {
  const mod = await import("e2b");
  return mod.Sandbox as {
    create: (
      templateId: string,
      options: {
        apiKey: string;
        envs?: Record<string, string>;
        timeoutMs: number;
        metadata?: Record<string, string>;
      }
    ) => Promise<E2bSandboxLike>;
  };
}

function isE2bCommandResult(value: E2bCommandHandle | E2bCommandResult): value is E2bCommandResult {
  // CommandHandle has a wait() method; CommandResult (foreground) does not.
  return !("wait" in value && typeof (value as E2bCommandHandle).wait === "function");
}

// ---------------------------------------------------------------------------
// File collection helper
// ---------------------------------------------------------------------------

type WorkspaceFile = {
  relativePath: string;
  data: string | ArrayBuffer;
};

export async function collectLocalWorkspaceFiles(dirPath: string): Promise<WorkspaceFile[]> {
  const results: WorkspaceFile[] = [];
  await walkDirectory(dirPath, dirPath, results);
  return results;
}

async function walkDirectory(
  rootPath: string,
  currentPath: string,
  results: WorkspaceFile[]
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      await walkDirectory(rootPath, fullPath, results);
    } else if (entry.isFile()) {
      const buffer = await readFile(fullPath);
      results.push({ relativePath, data: buffer.buffer as ArrayBuffer });
    }
  }
}
