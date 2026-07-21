// E2B implementation of deepagents' SandboxBackendProtocolV2 (bead im5e.2).
//
// There is no official E2B backend in deepagentsjs (only LangSmith/Deno/
// Daytona/Modal), so this subclasses `BaseSandbox`, which derives every file
// tool (ls/read/write/edit/grep/glob) from just three primitives: execute(),
// uploadFiles(), downloadFiles(). ls/glob and text reads go through execute()
// (POSIX shell), while write/edit/readRaw and binary reads go through
// upload/downloadFiles() — read() is the one hybrid. We implement those three
// primitives over the same E2B JS SDK the other runtimes already use.
//
// Design decisions locked in the bead:
// - LAZY creation: the sandbox spins up on the first execute()/file call, not
//   at session start — chat-only turns pay zero sandbox cost. The instance is
//   memoized for the session lifetime, so files persist across turns.
// - Per-execute timeout + output cap enforced at THIS layer (the sandbox-level
//   timeout is a lifetime cap, not a per-command one).
// - Slim template (Python + data libs, no agent CLIs) — see
//   docker/template.ts; template id from E2B_TEMPLATE_ID.

import { BaseSandbox } from "deepagents";
import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadResult
} from "deepagents";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import {
  loadE2bSandboxClass,
  type E2bSandboxLike
} from "../runtime/e2b-sandbox.js";
import { resolveInsideSandbox } from "../runtime/sandbox-path.js";
import { createStageTimer } from "../runtime/startup-timing.js";

/** Combined-output cap for a single execute() result. Anything past this is
 *  dropped with `truncated: true` — the model does not need megabytes of
 *  stdout, and unbounded output would balloon the prompt. */
const MAX_EXECUTE_OUTPUT_CHARS = 64_000;

/** Model-facing error for paths that escape the session workspace. */
const OUTSIDE_WORKSPACE_ERROR = "Path is outside the session workspace";

export type E2bDeepAgentsSandboxOptions = {
  apiKey: string;
  templateId: string;
  sandboxTimeoutMs: number;
  executeTimeoutMs: number;
  /** Session workspace root inside the sandbox (files + cwd live here). */
  workspacePath: string;
  sessionId: string;
  runtimeId: string;
  logger: FastifyBaseLogger;
  /** Test-only injection of the (dynamically imported) Sandbox class. */
  loadSandboxClass?: typeof loadE2bSandboxClass;
};

export class E2bDeepAgentsSandbox extends BaseSandbox {
  private sandboxPromise: Promise<E2bSandboxLike> | null = null;
  private sandboxId: string | null = null;
  private killed = false;

  constructor(private readonly options: E2bDeepAgentsSandboxOptions) {
    super();
  }

  /** Stable identifier — E2B's sandbox id once created, runtime id before. */
  get id(): string {
    return this.sandboxId ?? this.options.runtimeId;
  }

  /** True once a real sandbox has been (or is being) created. */
  get isCreated(): boolean {
    return this.sandboxPromise !== null;
  }

  /**
   * Run an operation against the memoized sandbox, transparently recreating it
   * once if the sandbox has gone away. E2B sandboxes have a hard lifetime cap
   * (`sandboxTimeoutMs`, never extended on activity), so a long session
   * eventually outlives its sandbox; past that every SDK call throws
   * SandboxNotFoundError. Without recovery the memo would stay poisoned and
   * shell/file tools + artifact sync would be dead for the rest of the session.
   * On a sandbox-gone error we drop the memo and create a fresh sandbox — the
   * in-sandbox workspace files are lost (accepted cold-start cost), but the
   * session stays functional. A file-level not-found (FileNotFoundError) is NOT
   * sandbox-gone and must not trigger recreation.
   */
  private async withSandbox<T>(
    op: (sandbox: E2bSandboxLike) => Promise<T>,
    // Whether re-running `op` against a fresh sandbox on a sandbox-gone error is
    // safe. True for idempotent ops (ls/read/grep/glob/upload/download) — the
    // default. FALSE for execute(): the E2B SDK can't distinguish "command never
    // ran" from "ran to completion but the terminal event was lost when the
    // streaming RPC dropped", so a blind replay double-executes side-effecting
    // shell commands (a second `curl -X POST .../deploy`). For those we still
    // drop the poisoned memo (so the NEXT call gets a fresh sandbox) but surface
    // the error instead of replaying this command.
    retryOnSandboxGone = true
  ): Promise<T> {
    const sandbox = await this.getSandbox();
    try {
      return await op(sandbox);
    } catch (err: unknown) {
      if (!this.killed && isSandboxGoneError(err)) {
        this.options.logger.warn(
          {
            err,
            sessionId: this.options.sessionId,
            sandboxId: this.sandboxId,
            retried: retryOnSandboxGone
          },
          retryOnSandboxGone
            ? "Deep Agents E2B sandbox gone; recreating and retrying"
            : "Deep Agents E2B sandbox gone mid-execute; not replaying the command"
        );
        this.sandboxPromise = null;
        this.sandboxId = null;
        if (retryOnSandboxGone) {
          const fresh = await this.getSandbox();
          return op(fresh);
        }
      }
      throw err;
    }
  }

  /**
   * Lazily create the sandbox on first use and memoize it for the session.
   * A failed creation clears the memo so the next call retries instead of
   * poisoning the session with a rejected promise.
   */
  private getSandbox(): Promise<E2bSandboxLike> {
    if (this.killed) {
      return Promise.reject(new Error("Deep Agents sandbox has been terminated."));
    }
    if (!this.sandboxPromise) {
      const timer = createStageTimer();
      const loader = this.options.loadSandboxClass ?? loadE2bSandboxClass;
      this.sandboxPromise = (async () => {
        const Sandbox = await loader();
        const sandbox = await timer.time("sandboxCreateMs", () =>
          Sandbox.create(this.options.templateId, {
            apiKey: this.options.apiKey,
            envs: {},
            timeoutMs: this.options.sandboxTimeoutMs,
            metadata: {
              provider: "deep-agents",
              sessionId: this.options.sessionId,
              runtimeId: this.options.runtimeId
            }
          })
        );
        this.sandboxId = sandbox.sandboxId;
        try {
          await sandbox.commands.run(`mkdir -p ${shellQuote(this.options.workspacePath)}`, {
            timeoutMs: 30_000
          });
        } catch (err) {
          // The sandbox was created but the workspace prep failed, so it's
          // unusable. Kill it before the .catch below clears the memo — once
          // sandboxPromise is nulled, kill() can no longer reach this instance,
          // and it would otherwise leak (billable) until E2B's sandboxTimeoutMs.
          this.sandboxId = null;
          await sandbox.kill().catch(() => {});
          throw err;
        }
        this.options.logger.info(
          {
            sessionId: this.options.sessionId,
            runtimeId: this.options.runtimeId,
            sandboxId: sandbox.sandboxId,
            templateId: this.options.templateId,
            sandboxCreateMs: timer.timings.sandboxCreateMs
          },
          "Deep Agents E2B sandbox lazily created"
        );
        return sandbox;
      })();
      this.sandboxPromise.catch(() => {
        // Retry on next use — see method comment.
        this.sandboxPromise = null;
        this.sandboxId = null;
      });
    }
    return this.sandboxPromise;
  }

  /**
   * Map an agent-visible path onto the session workspace. The model addresses
   * files with workspace-rooted absolute paths ("/notes.txt"), but tools also
   * pass real sandbox-absolute paths (a shell command's output path echoed
   * into write_artifact.filePath) — those must resolve to themselves, not be
   * re-rooted into a doubled "<ws>/home/user/workspace/…" path. Everything is
   * confined to the workspace via the shared traversal guard, so a hostile
   * "../../etc/passwd" throws instead of escaping.
   */
  private toSandboxPath(filePath: string): string {
    if (filePath.startsWith("/")) {
      const normalized = path.posix.normalize(filePath);
      const isInsideWorkspace =
        normalized === this.options.workspacePath ||
        normalized.startsWith(`${this.options.workspacePath}/`);
      return resolveInsideSandbox(
        this.options.workspacePath,
        isInsideWorkspace ? normalized : `.${filePath}`
      );
    }
    return resolveInsideSandbox(this.options.workspacePath, filePath);
  }

  // F10 — turn-abort does NOT cancel the server-side command. deepagents'
  // BaseSandbox.execute(command: string) exposes no AbortSignal, so on Stop the
  // graph tears down but this command keeps running server-side until it finishes
  // or hits `executeTimeoutMs` (the orphan is billable but bounded by that cap).
  // E2B's foreground `commands.run(signal)` only aborts the CLIENT wait, not the
  // remote process — real cancellation needs `background:true` + tracking the pid
  // + `commands.kill(pid)` on abort, which in turn needs the turn's abort signal
  // threaded down through the deepagents sandbox interface. That is a framework-
  // boundary change scoped as a follow-up (bead); keep `executeTimeoutMs` tight to
  // bound the orphan window in the meantime. Do NOT "fix" this by passing a signal
  // to the foreground run — that would abort the wait while leaving the process
  // (and its billing/side effects) alive, which is worse than the current bound.
  async execute(command: string): Promise<ExecuteResponse> {
    try {
      // retryOnSandboxGone=false: a dropped sandbox mid-execute must NOT replay
      // the command (it may have already run) — see withSandbox. The memo is
      // still dropped there, so a subsequent execute() gets a fresh sandbox.
      return await this.withSandbox(async (sandbox) => {
        try {
          const result = await sandbox.commands.run(command, {
            cwd: this.options.workspacePath,
            timeoutMs: this.options.executeTimeoutMs
          });
          return toExecuteResponse(
            result as { stdout?: string; stderr?: string; exitCode?: number }
          );
        } catch (err: unknown) {
          // The E2B SDK throws CommandExitError on non-zero exit codes (carrying
          // stdout/stderr/exitCode) and TimeoutError on per-command timeouts. The
          // agent loop treats non-zero exits as data, not exceptions — recover the
          // structured result when present.
          if (isCommandResultError(err)) {
            return toExecuteResponse(err);
          }
          const message = err instanceof Error ? err.message : String(err);
          if (/timeout/i.test(message)) {
            return {
              output: `[Command timed out after ${this.options.executeTimeoutMs}ms]`,
              exitCode: 124,
              truncated: false
            };
          }
          // A sandbox-gone error escapes withSandbox (no replay); handled below.
          throw err;
        }
      }, false);
    } catch (err: unknown) {
      // The sandbox dropped mid-command and we deliberately did not replay it.
      // Return a structured result so the agent loop can decide whether to re-run
      // (the memo is already cleared, so the next execute() lands on a fresh
      // sandbox), instead of an unhandled throw that aborts the turn.
      if (isSandboxGoneError(err)) {
        return {
          output:
            "[Command could not be completed: the sandbox was lost mid-execution and the " +
            "command was NOT re-run to avoid a double-execution. Re-run it if it did not take effect.]",
          exitCode: 1,
          truncated: false
        };
      }
      throw err;
    }
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.withSandbox(async (sandbox) => {
      const responses: FileUploadResponse[] = [];
      for (const [filePath, content] of files) {
        try {
          const sandboxPath = this.toSandboxPath(filePath);
          await sandbox.files.write([{ path: sandboxPath, data: toExactArrayBuffer(content) }]);
          responses.push({ path: filePath, error: null });
        } catch (err: unknown) {
          // Let a sandbox-gone error escape so withSandbox recreates + retries
          // the whole batch instead of reporting every file as failed.
          if (isSandboxGoneError(err)) throw err;
          this.options.logger.warn(
            { err, filePath, sessionId: this.options.sessionId },
            "Deep Agents sandbox file upload failed"
          );
          responses.push({ path: filePath, error: toUploadErrorCode(err) });
        }
      }
      return responses;
    });
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.withSandbox(async (sandbox) => {
      const responses: FileDownloadResponse[] = [];
      for (const filePath of paths) {
        try {
          const sandboxPath = this.toSandboxPath(filePath);
          const content = await sandbox.files.read(sandboxPath, { format: "bytes" });
          responses.push({ path: filePath, content, error: null });
        } catch (err: unknown) {
          // Sandbox-gone escapes to withSandbox for recreation; a per-file
          // not-found stays a structured error code.
          if (isSandboxGoneError(err)) throw err;
          responses.push({ path: filePath, content: null, error: toDownloadErrorCode(err) });
        }
      }
      return responses;
    });
  }

  // BaseSandbox derives ls/read/grep/glob from execute() with the given path
  // embedded in shell commands — remap those paths into the workspace first
  // so "/" means the workspace root, not the sandbox filesystem root. Paths
  // that escape the workspace return the protocol's structured `error` (which
  // the filesystem tools render to the model) instead of silently succeeding
  // against a different directory.

  override async ls(dirPath: string): Promise<LsResult> {
    const remapped = this.tryRemap(dirPath);
    if (remapped === null) return { error: OUTSIDE_WORKSPACE_ERROR };
    return super.ls(remapped);
  }

  override async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    // Without this override the text branch of BaseSandbox.read() embeds the
    // raw path in an awk command, bypassing the workspace remap that write()
    // applies — breaking write-then-read round-trips on "/"-rooted paths
    // (including the library's own large-tool-result eviction, which writes
    // "/large_tool_results/<id>.txt" and then tells the model to read it).
    const remapped = this.tryRemap(filePath);
    if (remapped === null) return { error: OUTSIDE_WORKSPACE_ERROR };
    return super.read(remapped, offset, limit);
  }

  override async grep(
    pattern: string,
    dirPath?: string | null,
    glob?: string | null
  ): Promise<GrepResult> {
    const base = dirPath == null ? this.options.workspacePath : this.tryRemap(dirPath);
    if (base === null) return { error: OUTSIDE_WORKSPACE_ERROR };
    return super.grep(pattern, base, glob);
  }

  override async glob(pattern: string, dirPath?: string): Promise<GlobResult> {
    const base = dirPath === undefined ? this.options.workspacePath : this.tryRemap(dirPath);
    if (base === null) return { error: OUTSIDE_WORKSPACE_ERROR };
    return super.glob(pattern, base);
  }

  /** Workspace remap, or null when the path escapes the workspace. */
  private tryRemap(targetPath: string): string | null {
    try {
      return this.toSandboxPath(targetPath);
    } catch {
      return null;
    }
  }

  // ── Adapter-facing helpers (write_artifact, artifact sync) ────────────────

  /** Read raw bytes at a workspace-relative path (adapter readRuntimeFile). */
  async readFileBytes(filePath: string): Promise<Uint8Array> {
    return this.withSandbox((sandbox) =>
      sandbox.files.read(this.toSandboxPath(filePath), { format: "bytes" })
    );
  }

  /** Size of a workspace file without buffering it (adapter statRuntimeFile). */
  async statFile(filePath: string): Promise<{ sizeBytes: number }> {
    return this.withSandbox(async (sandbox) => {
      const info = await sandbox.files.getInfo(this.toSandboxPath(filePath));
      return { sizeBytes: info.size };
    });
  }

  /** Write raw bytes at a workspace-relative path; returns the sandbox path. */
  async writeFileBytes(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string> {
    return this.withSandbox(async (sandbox) => {
      const sandboxPath = this.toSandboxPath(filePath);
      const payload: string | ArrayBuffer =
        typeof data === "string" || data instanceof ArrayBuffer ? data : toExactArrayBuffer(data);
      await sandbox.files.write([{ path: sandboxPath, data: payload }]);
      return sandboxPath;
    });
  }

  /** Kill the sandbox if one was ever created. Idempotent. */
  async kill(): Promise<void> {
    this.killed = true;
    const pending = this.sandboxPromise;
    this.sandboxPromise = null;
    if (!pending) return;
    try {
      const sandbox = await pending;
      await sandbox.kill();
    } catch (err: unknown) {
      this.options.logger.warn(
        { err, sessionId: this.options.sessionId, sandboxId: this.sandboxId },
        "Failed to kill Deep Agents E2B sandbox"
      );
    }
  }
}

function toExecuteResponse(result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): ExecuteResponse {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
  const truncated = combined.length > MAX_EXECUTE_OUTPUT_CHARS;
  return {
    output: truncated ? combined.slice(0, MAX_EXECUTE_OUTPUT_CHARS) : combined,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    truncated
  };
}

/** Structural check for the SDK's CommandExitError (carries the full result). */
function isCommandResultError(
  err: unknown
): err is { stdout?: string; stderr?: string; exitCode?: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "exitCode" in err &&
    typeof (err as { exitCode?: unknown }).exitCode === "number"
  );
}

/**
 * Copy a byte view into a standalone ArrayBuffer of exactly its bytes. Never
 * hand `view.buffer` (or `Buffer.prototype.slice().buffer` — a view, not a
 * copy) to the SDK: pooled Node Buffers share an 8KB ArrayBuffer, so that
 * would upload the whole pool and corrupt small files with NUL padding.
 */
function toExactArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * True when the SDK error means the sandbox itself is gone (expired past its
 * lifetime cap, killed, or otherwise no longer running) — as opposed to a
 * file-level miss. E2B raises `SandboxNotFoundError` for this; we match on the
 * constructor name (this module imports `e2b` lazily, so no static class ref)
 * with a message fallback for wrapped/re-thrown variants. `FileNotFoundError`
 * is deliberately NOT matched — a missing file is not a dead sandbox.
 */
export function isSandboxGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "SandboxNotFoundError") return true;
  if (err.name === "FileNotFoundError") return false;
  return /sandbox.*(not\s*found|no longer running|does not exist|was not found)/i.test(err.message);
}

function isTraversalError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("inside the session workspace");
}

// The protocol's FileOperationError codes are rendered verbatim to the model
// (e.g. "Failed to write to X: permission_denied"), so map E2B SDK failures to
// the code that best steers recovery instead of collapsing everything to one.

function toUploadErrorCode(err: unknown): "invalid_path" | "is_directory" | "permission_denied" {
  if (isTraversalError(err)) return "invalid_path";
  if (isDirectoryError(err)) return "is_directory";
  // invalid_path is reserved for path-validation failures — a transient
  // sandbox/network error must not read as "your path is wrong" and steer the
  // model into rewriting a correct path. permission_denied is the least-bad
  // remaining code for unknown upload failures.
  return "permission_denied";
}

function toDownloadErrorCode(
  err: unknown
): "invalid_path" | "is_directory" | "permission_denied" | "file_not_found" {
  if (isTraversalError(err)) return "invalid_path";
  if (isDirectoryError(err)) return "is_directory";
  if (isPermissionError(err)) return "permission_denied";
  return "file_not_found";
}

function isDirectoryError(err: unknown): boolean {
  return err instanceof Error && /EISDIR|is a directory/i.test(err.message);
}

function isPermissionError(err: unknown): boolean {
  return err instanceof Error && /EACCES|EPERM|permission denied/i.test(err.message);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
