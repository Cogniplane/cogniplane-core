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
// - Network (VULN-13): the network policy of a sandbox is fixed when the sandbox
//   is created, and nothing in this file changes it afterwards. The call that
//   changes the network of a running sandbox is not in the interface that this
//   file uses (../runtime/e2b-sandbox.ts), so there is no update to race. A
//   sandbox is created under the policy as it is read from the tenant settings
//   at that moment: deny all egress, except the hosts the tenant approved. The
//   provider reports the network back, and a sandbox that differs is killed
//   before any workspace command runs in it. At the first use of each turn or
//   job, and when a runtime reconnects, one live read compares the sandbox with
//   the policy as it is then. A match holds for the whole turn. A mismatch (the
//   admin changed the list, a sandbox from before the policy, unexpected rules)
//   replaces the sandbox, and the session lease is checked in the database
//   before the old one is killed. A sandbox that cannot be read in time is kept,
//   nothing runs in it, and the call fails. No command and no file operation
//   runs in a sandbox that was not confirmed in the current turn. An operation
//   takes its turn when it is called, before it awaits anything, and runs only
//   while that turn is live: a turn that ended, was cancelled, or was replaced by
//   the next one, and a runtime that was disposed, run nothing more. That holds
//   for the creation of a sandbox that an earlier turn began too: it stops before
//   the first command in the new sandbox. A method that deepagents inherits to
//   BaseSandbox and that composes several steps (edit, delete) takes its turn once,
//   when it is called, and every step of it uses that turn (see the audit above the
//   overrides). A kill that fails is tried again, and
//   when it still fails it is logged as an error: the old sandbox then runs until
//   the provider expires it, with the network that it was created with. See
//   ../runtime/sandbox-network-policy.ts for what the provider enforces.

import { BaseSandbox } from "deepagents";
import type {
  DeleteResult,
  EditResult,
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
  toE2bCreateOptions,
  type E2bSandboxClassLike,
  type E2bSandboxInfoLike,
  type E2bSandboxLike
} from "../runtime/e2b-sandbox.js";
import {
  checkReportedNetwork,
  SandboxNetworkPolicyError,
  SandboxNetworkPolicyUnconfirmedError,
  SandboxTurnEndedError,
  toE2bCreateNetwork,
  type SandboxNetworkPolicy
} from "../runtime/sandbox-network-policy.js";
import { resolveInsideSandbox } from "../runtime/sandbox-path.js";
import { createStageTimer } from "../runtime/startup-timing.js";
import type { DeepAgentsSandboxBinding } from "./deep-agents-types.js";

/** Combined-output cap for a single execute() result. Anything past this is
 *  dropped with `truncated: true` — the model does not need megabytes of
 *  stdout, and unbounded output would balloon the prompt. */
const MAX_EXECUTE_OUTPUT_CHARS = 64_000;

/** Model-facing error for paths that escape the session workspace. */
const OUTSIDE_WORKSPACE_ERROR = "Path is outside the session workspace";

/**
 * Waits before each new try of a read of the network report of a sandbox, or of a
 * kill, after a failed one: four tries in all, with about 1.75 s of waiting. A read
 * that still fails leaves the sandbox as it is and fails the call. A kill that
 * still fails is logged, and the sandbox is replaced all the same. The tries also
 * stop at the one deadline of the check, whichever comes first.
 */
const DEFAULT_NETWORK_RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000];

/** What acquireSandbox hands to an operation: the sandbox, and the memo it came from. */
type AcquiredSandbox = { bound: Promise<E2bSandboxLike>; sandbox: E2bSandboxLike };

/**
 * One turn or job of this runtime (see beginTurn). It is live until the turn ends or
 * is cancelled, or the next turn begins, and not after the runtime is disposed. An
 * operation takes the token of the turn that is current when it is called, before it
 * awaits anything, and keeps it. A later turn never adopts what an earlier one began.
 */
type TurnToken = { live: boolean };

/** The time by which a network check must be done (Date.now() ms). */
type Deadline = { readonly expiresAt: number };

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
  /**
   * Reads the network policy of the tenant as it is now, from the tenant
   * settings (VULN-13). A sandbox is created under it, and each turn compares the
   * live network of the sandbox with it. It is called every time and its result
   * is not kept, so a change of the approved hosts applies at the next creation
   * or turn without a refresh of the runtime. A policy that cannot be read fails
   * the call, and nothing is created or run.
   */
  resolveNetworkPolicy: () => Promise<SandboxNetworkPolicy>;
  /**
   * The longest time for one check of a sandbox: the read of the policy, the
   * reads of the network report, and the retries of them
   * (E2B_NETWORK_CONFIRM_TIMEOUT_MS). When it passes, the call fails and the
   * sandbox is kept.
   */
  networkConfirmTimeoutMs: number;
  /**
   * The longest time for one request in that check (E2B_NETWORK_REQUEST_TIMEOUT_MS).
   * It never exceeds what is left of the deadline.
   */
  networkRequestTimeoutMs: number;
  /**
   * Checks in the database that this runtime still owns the session, which is
   * that its execution lease is current. It runs before every try to kill a
   * sandbox that does not match the policy, and it throws when ownership is lost,
   * and then the sandbox is neither killed nor replaced. Without it, nothing stops
   * a runtime that lost the session from replacing the sandbox.
   */
  requireOwnership?: () => Promise<void>;
  /**
   * Called when a sandbox is transparently replaced by a fresh one — the
   * point at which every agent-written file and every synced artifact in the
   * workspace is lost. Without this the model just sees `file_not_found` on
   * work it did itself and has no way to know why. The adapter turns it into
   * a runtime notice on the active turn. `reason` is `expired` when the
   * provider no longer had the sandbox, and `network_policy` when the sandbox
   * did not match the network policy: the admin changed the approved hosts, or
   * the sandbox was created before the policy, or it has unexpected rules.
   */
  onSandboxRecreated?: (info: { previousSandboxId: string | null; reason?: SandboxReplacementReason }) => void;
  sandboxBinding?: DeepAgentsSandboxBinding;
  /** Test-only injection of the (dynamically imported) Sandbox class. */
  loadSandboxClass?: typeof loadE2bSandboxClass;
  /** Test-only: waits before each new read of the network report in a check. */
  networkRetryBackoffMs?: readonly number[];
};

export type SandboxReplacementReason = "expired" | "network_policy";

export class E2bDeepAgentsSandbox extends BaseSandbox {
  private sandboxPromise: Promise<E2bSandboxLike> | null = null;
  private sandboxId: string | null = null;
  private failedSandboxId: string | null = null;
  private killed = false;
  /** The turn or job that is current (beginTurn). Null until the first one begins: nothing runs before that. */
  private turn: TurnToken | null = null;
  /**
   * The sandbox that was confirmed in a turn, and the turn: created under the
   * policy of that turn, or read and found as that policy. No command and no file
   * operation runs in a sandbox that is not confirmed in the current turn.
   */
  private confirmed: { sandbox: E2bSandboxLike; turn: TurnToken } | null = null;
  /** The check or creation in progress. Every caller of its turn shares it, so waiters never queue cycles of their own. */
  private acquiring: { turn: TurnToken; promise: Promise<AcquiredSandbox> } | null = null;

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
   * once if the sandbox has gone away. E2B sandboxes have a lifetime cap
   * (`sandboxTimeoutMs`) which extendTimeout() pushes back at each turn start,
   * making it an idle timeout — but a session idle past the cap, or one whose
   * extension call failed, still outlives its sandbox; past that every SDK call throws
   * SandboxNotFoundError. Without recovery the memo would stay poisoned and
   * shell/file tools + artifact sync would be dead for the rest of the session.
   * On a sandbox-gone error we drop the memo and create a fresh sandbox — the
   * in-sandbox workspace files are lost (accepted cold-start cost), but the
   * session stays functional. A file-level not-found (FileNotFoundError) is NOT
   * sandbox-gone and must not trigger recreation.
   *
   * `turn` is the turn of the operation. The caller takes it once, when the operation is
   * called, before anything is awaited (currentTurn), and a method that is made of several
   * steps hands the same turn to each of them. This does not take it again: a step that took
   * the turn that is current when it starts would run in a turn that began after its operation did.
   */
  private async withSandbox<T>(
    turn: TurnToken,
    // `live` throws when the turn of the operation is over. A step that sends more
    // than one request calls it before each, so that a turn that is over sends no more.
    op: (sandbox: E2bSandboxLike, live: () => void) => Promise<T>,
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
    // A turn that begins while this operation waits does not adopt it: the
    // operation fails instead of running in that turn. A turn that is already over
    // fails here, before the saved record is read.
    this.requireLive(turn);
    await this.reconcileSandbox();
    this.requireLive(turn);
    // Capture the promise this call is bound to, so a concurrent op that
    // already replaced the sandbox is detected below instead of having its
    // replacement discarded. The sandbox is confirmed in this turn before any
    // operation, a command or a file operation, runs in it.
    const { bound: boundPromise, sandbox } = await this.acquireSandbox(turn);
    // The last check. Nothing is awaited between it and the dispatch below.
    this.requireLive(turn);
    const live = () => this.requireLive(turn);
    try {
      return await op(sandbox, live);
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
        // Only the FIRST caller to observe this sandbox's death replaces it.
        // Concurrent ops against the same dead sandbox all land here; without
        // this guard the second would discard the first's fresh sandbox, start
        // a third, fire a duplicate notice, and split writes across two
        // sandboxes while the memo kept only one. `sandboxPromise` having
        // already moved on is the marker that someone else did the work.
        const weReplaceIt = this.sandboxPromise === boundPromise;
        if (weReplaceIt) {
          // Read the id of the sandbox THIS call was bound to, not the mutable
          // field, which a concurrent replacement may already have moved.
          const previousSandboxId = this.sandboxId;
          this.sandboxPromise = null;
          this.sandboxId = null;
          this.failedSandboxId = previousSandboxId;
          // Fire for BOTH branches: the workspace is equally gone whether or
          // not we replay this particular op — the non-retry branch just
          // declines to re-run a side-effecting command, and the next call gets
          // the fresh sandbox either way.
          this.notifyRecreated(previousSandboxId, "expired");
        }
        if (retryOnSandboxGone) {
          // Whoever won the replacement, acquireSandbox() now yields the live
          // one, created and confirmed like any other. It is asked for in the turn
          // of this operation: if that turn is over, the retry does not run.
          const { sandbox: fresh } = await this.acquireSandbox(turn);
          this.requireLive(turn);
          return op(fresh, live);
        }
      }
      throw err;
    }
  }

  private async reconcileSandbox(): Promise<void> {
    if (!this.options.sandboxBinding || !this.sandboxId) return;
    const saved = await this.options.sandboxBinding.load();
    if (saved?.sandboxId === this.sandboxId) return;
    this.sandboxPromise = null;
    this.sandboxId = null;
    this.failedSandboxId = null;
  }

  /**
   * Starts a turn or a job. The adapter calls it at the start of every one,
   * before anything uses the sandbox, and nothing runs before the first call. The
   * runtime outlives a turn, and the approved hosts can change in between, so what
   * was confirmed in an earlier turn no longer counts: the first operation of this
   * turn reads the live network of the sandbox once, compares it with the policy as
   * it is now, and replaces the sandbox if they differ. The other operations of the
   * turn reuse that result. The turn before this one is over: an operation that it
   * began and that is still waiting fails, and so does a creation of a sandbox that
   * it began, which stops before its first command. It calls no provider and cannot fail.
   *
   * It returns the function that ends the turn. Call it when the turn is over,
   * however it ended: from then on nothing that the turn asked for runs. `signal` is
   * the cancellation of the turn, and the turn ends when it aborts. Disposing the
   * runtime ends every turn.
   */
  beginTurn(signal?: AbortSignal): () => void {
    const turn: TurnToken = { live: true };
    // The next turn replaces the one before it: what that one began must not run in this one.
    if (this.turn) this.turn.live = false;
    this.turn = turn;
    const end = () => {
      turn.live = false;
      signal?.removeEventListener("abort", end);
    };
    if (signal?.aborted) end();
    else signal?.addEventListener("abort", end, { once: true });
    return end;
  }

  /** The turn that is current. An operation that has no live turn is refused, and nothing is run for it. */
  private currentTurn(): TurnToken {
    const turn = this.turn;
    if (!turn) throw new SandboxNetworkPolicyUnconfirmedError("no turn has begun in this runtime");
    this.requireLive(turn);
    return turn;
  }

  /**
   * Throws unless the turn is live and the runtime was not disposed. It is the last
   * check before a command, a file operation, the workspace preparation of a new
   * sandbox, or the record of it: each of them calls it with nothing awaited between.
   */
  private requireLive(turn: TurnToken): void {
    if (this.killed) throw this.terminatedError();
    if (!turn.live) throw new SandboxTurnEndedError();
  }

  private memoize(pending: Promise<E2bSandboxLike>): Promise<E2bSandboxLike> {
    this.sandboxPromise = pending;
    void pending.catch(() => {
      // Retry on next use — see getSandbox.
      if (this.sandboxPromise === pending) {
        this.sandboxPromise = null;
        this.sandboxId = null;
      }
    });
    return pending;
  }

  /**
   * Lazily create the sandbox on first use and memoize it for the session.
   * A failed creation clears the memo so the next call retries instead of
   * poisoning the session with a rejected promise. The sandbox that this returns
   * may not be confirmed in the current turn. Operations go through
   * acquireSandbox, never through this.
   */
  private getSandbox(turn: TurnToken): Promise<E2bSandboxLike> {
    if (this.killed) return Promise.reject(this.terminatedError());
    return this.sandboxPromise ?? this.memoize(this.connectOrCreate(turn));
  }

  private loadSandboxClass(): Promise<E2bSandboxClassLike> {
    return (this.options.loadSandboxClass ?? loadE2bSandboxClass)();
  }

  /**
   * Reconnect to the sandbox saved for the session, or create one. A new sandbox
   * is confirmed before it is returned. A reconnected one is not: it keeps the
   * network that it was created with, so acquireSandbox reads it in this turn.
   */
  private async connectOrCreate(turn: TurnToken): Promise<E2bSandboxLike> {
    const timer = createStageTimer();
    const Sandbox = await this.loadSandboxClass();
    const saved = await this.options.sandboxBinding?.load() ?? null;
    const previousId = saved?.sandboxId ?? null;
    if (saved && saved.sandboxId !== this.failedSandboxId) {
      try {
        const existing = await Sandbox.connect(saved.sandboxId, {
          apiKey: this.options.apiKey, timeoutMs: this.options.sandboxTimeoutMs
        });
        this.sandboxId = existing.sandboxId;
        this.failedSandboxId = null;
        return existing;
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
        this.notifyRecreated(saved.sandboxId, "expired");
      }
    }
    return this.createSandbox(Sandbox, previousId, timer, turn);
  }

  /**
   * Creates a sandbox under the policy as it is read from the tenant settings
   * now, and does not hand it out until the provider reports that policy back.
   * Nothing runs in it before that, so a sandbox that does not match, or that
   * cannot be read, is killed and loses nothing. The record that names the
   * sandbox is written under the session lease, and the sandbox is killed when
   * that write fails: a runtime that lost the session cannot keep a sandbox.
   *
   * The creation belongs to the turn that began it. A sandbox that is made for a turn
   * that is over was made under the policy as that turn read it, and no later turn
   * compared it with its own, so it is killed and not used. The turn is checked
   * before the sandbox is made, before each read of it, before the first command in
   * it (the workspace preparation), and before the record is written.
   */
  private async createSandbox(
    Sandbox: E2bSandboxClassLike,
    previousId: string | null,
    timer: ReturnType<typeof createStageTimer>,
    turn: TurnToken
  ): Promise<E2bSandboxLike> {
    this.requireLive(turn);
    // The policy now, from the tenant settings. Not an earlier read of this runtime.
    const policy = await this.resolvePolicy(this.confirmationDeadline());
    this.requireLive(turn);
    const sandbox = await timer.time("sandboxCreateMs", () =>
      Sandbox.create(
        this.options.templateId,
        toE2bCreateOptions({
          apiKey: this.options.apiKey,
          timeoutMs: this.options.sandboxTimeoutMs,
          metadata: {
            provider: "deep-agents",
            sessionId: this.options.sessionId,
            runtimeId: this.options.runtimeId
          },
          network: toE2bCreateNetwork(policy)
        })
      )
    );
    try {
      // The provider can ignore an option. Nothing ran in the sandbox yet, so one that
      // does not report the policy, or cannot be read, is killed and loses nothing.
      const reported = await this.readReportedNetwork(Sandbox, sandbox.sandboxId, this.confirmationDeadline(), turn);
      const check = checkReportedNetwork(reported, policy);
      if (!check.ok) throw new SandboxNetworkPolicyError(check.reason);
      // The first command in the sandbox. If the turn ended while the sandbox was
      // made, no command runs in it: a turn that began since has not compared it.
      this.requireLive(turn);
      await sandbox.commands.run(`mkdir -p ${shellQuote(this.options.workspacePath)}`, {
        timeoutMs: 30_000
      });
      this.requireLive(turn);
      await this.options.sandboxBinding?.save(previousId, sandbox.sandboxId, policy.hash);
      this.sandboxId = sandbox.sandboxId;
      this.failedSandboxId = null;
      this.confirmed = { sandbox, turn };
    } catch (err) {
      // The sandbox was created but it is unusable: the workspace prep failed,
      // the policy was not confirmed, or the record could not be written. Kill it
      // before the .catch in memoize clears the memo — once sandboxPromise is
      // nulled, kill() can no longer reach this instance, and it would otherwise
      // leak (billable) until E2B's sandboxTimeoutMs. Nobody else knows this
      // sandbox yet, so no lease check is needed to kill it.
      this.sandboxId = null;
      await this.killWithRetries(sandbox, this.confirmationDeadline(), "unusable");
      throw err;
    }
    this.options.logger.info(
      {
        sessionId: this.options.sessionId,
        runtimeId: this.options.runtimeId,
        sandboxId: sandbox.sandboxId,
        templateId: this.options.templateId,
        sandboxCreateMs: timer.timings.sandboxCreateMs,
        ...this.policyLogFields(policy)
      },
      "Deep Agents E2B sandbox lazily created"
    );
    return sandbox;
  }

  /**
   * The sandbox for an operation, a command or a file operation, confirmed in the
   * current turn. A sandbox that was created in this turn is confirmed. One that
   * was reconnected, or kept from an earlier turn, is read once, and its network
   * is compared with the policy as it is now (checkAtTurnStart). One acquisition
   * runs at a time, and every caller of the turn shares it, a failure included:
   * waiters never queue cycles of their own, so a provider that does not answer
   * costs one deadline, not one per waiting call. An acquisition that an earlier
   * turn started is not shared with the next turn.
   *
   * - A match holds for the turn: the next operations read nothing.
   * - The sandbox does not match, or it is gone: it is replaced by a sandbox that
   *   is created and confirmed under the policy as it is now. Its files are lost,
   *   and the user sees the `Workspace reset` notice. A sandbox that exists is
   *   killed first, and only while the session lease is current.
   * - The sandbox cannot be read in time: this throws and the sandbox stays.
   *   Nothing runs in it, its files are kept, and the next call asks again.
   */
  private acquireSandbox(turn: TurnToken): Promise<AcquiredSandbox> {
    try {
      this.requireLive(turn);
    } catch (error) {
      return Promise.reject(error);
    }
    const running = this.acquiring;
    if (running && running.turn === turn) return running.promise;
    const entry: { turn: TurnToken; promise: Promise<AcquiredSandbox> } = {
      turn,
      promise: this.acquireConfirmedSandbox(turn).finally(() => {
        if (this.acquiring === entry) this.acquiring = null;
      })
    };
    this.acquiring = entry;
    return entry.promise;
  }

  private async acquireConfirmedSandbox(turn: TurnToken): Promise<AcquiredSandbox> {
    for (;;) {
      this.requireLive(turn);
      const bound = this.getSandbox(turn);
      let sandbox: E2bSandboxLike;
      try {
        sandbox = await bound;
      } catch (error) {
        // This turn may have waited for the creation that an earlier turn began.
        // That creation stopped because its own turn is over, and its memo is
        // cleared. If this turn is live, it creates a sandbox of its own.
        this.requireLive(turn);
        if (error instanceof SandboxTurnEndedError) continue;
        throw error;
      }
      this.requireLive(turn);
      if (this.confirmed?.sandbox === sandbox && this.confirmed.turn === turn) return { bound, sandbox };
      const verdict = await this.checkAtTurnStart(sandbox, turn);
      this.requireLive(turn);
      if (verdict === "match") {
        this.confirmed = { sandbox, turn };
        return { bound, sandbox };
      }
      // The next round creates the replacement, under the policy as it is then.
      await this.retireSandbox(bound, sandbox, verdict === "gone" ? "expired" : "network_policy", turn);
    }
  }

  /**
   * One live read of the network of a sandbox that was not created in this turn,
   * compared with the policy as it is now. "mismatch" is any difference in the
   * egress rules or in the public-URL setting: a changed list of hosts, a sandbox
   * from before the policy (the provider reports no network for it, and its URLs
   * are public), or unexpected rules. "gone" is a sandbox that the provider no
   * longer has. It throws SandboxNetworkPolicyUnconfirmedError when the policy or
   * the report cannot be read in time, and then the sandbox is kept.
   */
  private async checkAtTurnStart(sandbox: E2bSandboxLike, turn: TurnToken): Promise<"match" | "mismatch" | "gone"> {
    const deadline = this.confirmationDeadline();
    const Sandbox = await this.loadSandboxClass();
    let reported: E2bSandboxInfoLike;
    try {
      reported = await this.readReportedNetwork(Sandbox, sandbox.sandboxId, deadline, turn);
    } catch (error) {
      if (isSandboxGoneError(error)) return "gone";
      throw error;
    }
    const policy = await this.resolvePolicy(deadline);
    const check = checkReportedNetwork(reported, policy);
    if (check.ok) return "match";
    this.options.logger.warn(
      { sessionId: this.options.sessionId, sandboxId: sandbox.sandboxId, ...this.policyLogFields(policy), reason: check.reason },
      "Deep Agents E2B sandbox does not match the network policy; replacing it"
    );
    return "mismatch";
  }

  /**
   * One read of the network report of a sandbox from the provider, with short
   * retries inside the deadline. It throws SandboxNetworkPolicyUnconfirmedError
   * when the last read failed or the deadline passed, and a sandbox-gone error at
   * once. A report that differs from the policy is an answer, not a failure: the
   * caller compares it. It stops, and reads no more, when the turn is over.
   */
  private async readReportedNetwork(
    Sandbox: E2bSandboxClassLike,
    sandboxId: string,
    deadline: Deadline,
    turn: TurnToken
  ): Promise<E2bSandboxInfoLike> {
    const backoffMs = this.options.networkRetryBackoffMs ?? DEFAULT_NETWORK_RETRY_BACKOFF_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      if (attempt > 0) await this.pause(deadline, backoffMs[attempt - 1]!);
      this.requireLive(turn);
      try {
        return await this.bounded(deadline, (limits) =>
          Sandbox.getInfo(sandboxId, { apiKey: this.options.apiKey, ...limits })
        );
      } catch (error) {
        if (error instanceof SandboxNetworkPolicyUnconfirmedError || isSandboxGoneError(error)) throw error;
        lastError = error;
      }
    }
    throw new SandboxNetworkPolicyUnconfirmedError("the provider did not report the sandbox network", { cause: lastError });
  }

  /**
   * The network policy of the tenant now. A policy that cannot be read fails the
   * call: nothing is created, and nothing is replaced, on a policy that is a guess.
   */
  private async resolvePolicy(deadline: Deadline): Promise<SandboxNetworkPolicy> {
    try {
      return await this.bounded(deadline, () => this.options.resolveNetworkPolicy());
    } catch (error) {
      if (error instanceof SandboxNetworkPolicyUnconfirmedError) throw error;
      throw new SandboxNetworkPolicyUnconfirmedError("the network policy of the tenant could not be read", { cause: error });
    }
  }

  /** The deadline of a network check that starts now. */
  private confirmationDeadline(): Deadline {
    return { expiresAt: Date.now() + this.options.networkConfirmTimeoutMs };
  }

  /**
   * The time left to the deadline, in ms. Throws when none is left: the check
   * fails closed, the sandbox is kept, and nothing runs in it.
   */
  private requireTimeLeft(deadline: Deadline): number {
    const left = this.timeLeft(deadline);
    if (left <= 0) {
      this.options.logger.warn(
        { sessionId: this.options.sessionId, networkConfirmTimeoutMs: this.options.networkConfirmTimeoutMs },
        "Deep Agents E2B sandbox network policy was not confirmed in time; the sandbox is kept and the call fails"
      );
      throw new SandboxNetworkPolicyUnconfirmedError("the provider did not answer in time");
    }
    return left;
  }

  /** The time left to the deadline, in ms. It is zero or less when the deadline has passed. */
  private timeLeft(deadline: Deadline): number {
    return deadline.expiresAt - Date.now();
  }

  private terminatedError(): Error {
    return new Error("Deep Agents sandbox has been terminated.");
  }

  /** Waits `ms`, or less when the deadline is closer. Throws when the deadline has passed. */
  private async pause(deadline: Deadline, ms: number): Promise<void> {
    const wait = Math.min(ms, this.requireTimeLeft(deadline));
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    this.requireTimeLeft(deadline);
  }

  /**
   * One request, to the provider or to the database, limited in time. It never
   * gets more than the request timeout, nor more than the deadline has left. The
   * limit goes to the SDK, which cancels the request and its own retries, and it
   * also bounds the wait here, so a call that ignores the limit cannot hold the
   * check. A request that got no answer in time is a failure to try again, not a
   * verdict.
   */
  private async bounded<T>(
    deadline: Deadline,
    send: (limits: { requestTimeoutMs: number; signal: AbortSignal }) => Promise<T>
  ): Promise<T> {
    const timeoutMs = Math.min(this.options.networkRequestTimeoutMs, this.requireTimeLeft(deadline));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderRequestTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      const pending = Promise.resolve(send({ requestTimeoutMs: timeoutMs, signal: controller.signal }));
      // A request that was given up can still fail later. That must not be an unhandled rejection.
      pending.catch(() => {});
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Before a sandbox is killed: the database still says that this runtime owns
   * the session. A kill cannot be taken back, and the next owner may be using
   * the sandbox. A check that cannot be answered refuses the kill too.
   */
  private async fence(deadline: Deadline): Promise<void> {
    const requireOwnership = this.options.requireOwnership;
    if (!requireOwnership) return;
    try {
      await this.bounded(deadline, () => requireOwnership());
    } catch (error) {
      if (error instanceof SandboxNetworkPolicyUnconfirmedError) throw error;
      this.options.logger.warn(
        { err: error, sessionId: this.options.sessionId },
        "Deep Agents E2B sandbox not replaced: this runtime does not own the session, or ownership could not be checked"
      );
      throw new SandboxNetworkPolicyUnconfirmedError("ownership of the session could not be confirmed", { cause: error });
    }
  }

  /**
   * Drops a sandbox that does not match the policy, or that is gone. The next
   * round of acquireSandbox creates its replacement. A sandbox that exists is
   * killed first (with retries), and only while the session lease is current: if
   * the lease is lost, this throws and the sandbox is kept for the runtime that
   * owns the session now. If the kill still fails after the retries, it is logged
   * as an error, and the sandbox is replaced all the same: the old one then runs
   * until the provider expires it, and its processes keep the network that it had.
   */
  private async retireSandbox(
    bound: Promise<E2bSandboxLike>,
    sandbox: E2bSandboxLike,
    reason: SandboxReplacementReason,
    turn: TurnToken
  ): Promise<void> {
    if (reason === "network_policy") {
      const deadline = this.confirmationDeadline();
      // The lease and the turn are checked again before every try, so that a try that
      // comes after a delay does not kill the sandbox of the runtime that owns the session now.
      await this.killWithRetries(sandbox, deadline, "replaced", async () => {
        await this.fence(deadline);
        this.requireLive(turn);
      });
    }
    // Another caller may have replaced the memo already. Only its own sandbox is dropped.
    if (this.sandboxPromise === bound) {
      this.sandboxPromise = null;
      this.sandboxId = null;
      this.failedSandboxId = sandbox.sandboxId;
    }
    this.notifyRecreated(sandbox.sandboxId, reason);
  }

  /**
   * Kills a sandbox at the provider, and tries again after a failure, inside the
   * deadline: four tries, as for the reads. `beforeEach` runs before every try, and
   * the lease check goes there. When it throws, no more tries are made and the error
   * goes to the caller, so a lost lease never ends in a kill. A kill that still fails
   * after the last try is logged as an error with the sandbox id, and this returns
   * false: the sandbox then runs until the provider expires it, and its processes
   * keep the network that it was created with. The caller goes on and replaces it.
   * "Gone" counts as killed.
   */
  private async killWithRetries(
    sandbox: E2bSandboxLike,
    deadline: Deadline,
    kind: "replaced" | "unusable",
    beforeEach?: () => Promise<void>
  ): Promise<boolean> {
    const backoffMs = this.options.networkRetryBackoffMs ?? DEFAULT_NETWORK_RETRY_BACKOFF_MS;
    let lastError: unknown;
    let tries = 0;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      if (attempt > 0) {
        const wait = Math.min(backoffMs[attempt - 1]!, this.timeLeft(deadline));
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      // No time is left: give up the tries. Nothing is sent after the deadline.
      if (this.timeLeft(deadline) <= 0) break;
      await beforeEach?.();
      tries += 1;
      try {
        await this.bounded(deadline, (limits) => sandbox.kill(limits));
        return true;
      } catch (error) {
        if (isSandboxGoneError(error)) return true;
        lastError = error;
      }
    }
    this.options.logger.error(
      { err: lastError, sessionId: this.options.sessionId, sandboxId: sandbox.sandboxId, tries },
      kind === "replaced"
        ? "Failed to kill a replaced Deep Agents E2B sandbox after retries; it runs until the provider expires it, with the network policy that it was created under"
        : "Failed to kill a new Deep Agents E2B sandbox that failed its checks, after retries; it runs until the provider expires it"
    );
    return false;
  }

  private policyLogFields(policy: SandboxNetworkPolicy) {
    return {
      networkMode: policy.mode,
      networkPolicyHash: policy.hash,
      allowedDomainCount: policy.allowedDomains.length
    };
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
    return this.executeIn(this.currentTurn(), command);
  }

  private async executeIn(turn: TurnToken, command: string): Promise<ExecuteResponse> {
    try {
      // retryOnSandboxGone=false: a dropped sandbox mid-execute must NOT replay
      // the command (it may have already run) — see withSandbox. The memo is
      // still dropped there, so a subsequent execute() gets a fresh sandbox.
      return await this.withSandbox(turn, async (sandbox) => {
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
    return this.uploadFilesIn(this.currentTurn(), files);
  }

  private async uploadFilesIn(turn: TurnToken, files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.withSandbox(turn, async (sandbox, live) => {
      const responses: FileUploadResponse[] = [];
      for (const [filePath, content] of files) {
        // Before each file, and outside the try: a turn that is over writes no more.
        live();
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
    return this.downloadFilesIn(this.currentTurn(), paths);
  }

  private async downloadFilesIn(turn: TurnToken, paths: string[]): Promise<FileDownloadResponse[]> {
    return this.withSandbox(turn, async (sandbox, live) => {
      const responses: FileDownloadResponse[] = [];
      for (const filePath of paths) {
        live();
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

  // Methods that deepagents (1.14.2, read from the installed source) inherits to
  // BaseSandbox, with the steps that each one is made of. Every step is one of the three
  // primitives of this class (execute, uploadFiles, downloadFiles), and each primitive takes
  // the turn that is current when it is called. A method of one step takes its turn
  // when it is called, because nothing is awaited before that step. A method of several
  // steps would take a turn for each, and a turn that began between two steps would run the
  // second one: the download of a cancelled edit could upload after the next turn wrote the file.
  // Those methods run on a view of this sandbox (scopedToCurrentTurn) whose primitives are
  // bound to the turn taken when the method was called.
  //
  //   ls       1 execute (find)                          read only        one step
  //   read     1 execute (awk), or 1 downloadFiles       read only        one step
  //   readRaw  1 downloadFiles                           read only        one step
  //   grep     1 execute (grep)                          read only        one step
  //   glob     1 execute (find)                          read only        one step
  //   write    1 uploadFiles                             writes           one step
  //   edit     downloadFiles, then uploadFiles           read, then write several steps: bound to one turn
  //   delete   execute (test -e), then execute (rm -rf)  check, then rm  several steps: bound to one turn
  //
  // The test "methods inherited from BaseSandbox" repeats this table against the installed
  // package: a method that was added, or a method that gained a step, fails it.

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

  /**
   * edit downloads the file, awaits, replaces the text, and uploads it: two requests, and the
   * second one writes. It runs on a view whose primitives use the turn taken now, so that the
   * upload of an edit whose turn is over does not run in the turn that began while its download
   * waited, over a file that the new turn wrote. The paths are confined by the primitives.
   */
  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean
  ): Promise<EditResult> {
    return super.edit.call(this.scopedToCurrentTurn(), filePath, oldString, newString, replaceAll);
  }

  /**
   * delete asks whether the path exists, awaits, and then removes it with `rm -rf`: two commands,
   * and the second one deletes. Like edit, it runs on a view bound to the turn taken now, so the
   * `rm` of a turn that is over does not delete what the next turn wrote. The path is remapped into
   * the workspace as for the other tools: BaseSandbox puts it into the command as it is, so
   * "/notes.txt" named the root of the sandbox here and not the file that write_file made, and
   * a path outside the workspace was removed. The result names the path that the model gave.
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const scoped = this.scopedToCurrentTurn();
    const remapped = this.tryRemap(filePath);
    if (remapped === null) return { error: OUTSIDE_WORKSPACE_ERROR };
    const result = await super.delete.call(scoped, remapped);
    return result.path === undefined ? result : { ...result, path: filePath };
  }

  /**
   * This sandbox, with its three primitives bound to the turn that is current now. A method that
   * is made of several primitives runs on this view (super.method.call(view, ...)): each step
   * then uses the turn of the call, and not the turn that is current when the step starts.
   * Everything else, including the options and the other methods, comes from the sandbox itself.
   */
  private scopedToCurrentTurn(): this {
    const turn = this.currentTurn();
    const scoped: this = Object.create(this);
    scoped.execute = (command: string) => this.executeIn(turn, command);
    scoped.uploadFiles = (files: Array<[string, Uint8Array]>) => this.uploadFilesIn(turn, files);
    scoped.downloadFiles = (paths: string[]) => this.downloadFilesIn(turn, paths);
    return scoped;
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
    return this.withSandbox(this.currentTurn(), (sandbox) =>
      sandbox.files.read(this.toSandboxPath(filePath), { format: "bytes" })
    );
  }

  /** Size of a workspace file without buffering it (adapter statRuntimeFile). */
  async statFile(filePath: string): Promise<{ sizeBytes: number }> {
    return this.withSandbox(this.currentTurn(), async (sandbox) => {
      const info = await sandbox.files.getInfo(this.toSandboxPath(filePath));
      return { sizeBytes: info.size };
    });
  }

  /** Write raw bytes at a workspace-relative path; returns the sandbox path. */
  async writeFileBytes(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string> {
    return this.withSandbox(this.currentTurn(), async (sandbox) => {
      const sandboxPath = this.toSandboxPath(filePath);
      const payload: string | ArrayBuffer =
        typeof data === "string" || data instanceof ArrayBuffer ? data : toExactArrayBuffer(data);
      await sandbox.files.write([{ path: sandboxPath, data: payload }]);
      return sandboxPath;
    });
  }

  private notifyRecreated(previousSandboxId: string | null, reason: SandboxReplacementReason): void {
    if (!this.options.onSandboxRecreated) return;
    try {
      this.options.onSandboxRecreated({ previousSandboxId, reason });
    } catch (err: unknown) {
      // A failing notice must never turn into a failed tool call.
      this.options.logger.warn(
        { err, sessionId: this.options.sessionId },
        "Deep Agents sandbox-recreated notice failed"
      );
    }
  }

  /**
   * Push the sandbox's lifetime cap back out to the full `sandboxTimeoutMs`,
   * making it an IDLE timeout instead of an absolute one. Called at each turn
   * start, after beginTurn.
   *
   * Without this the cap runs from first tool use of the session and is never
   * touched again, so a session that stays active past it loses its whole
   * workspace mid-turn — every agent-written file and every synced artifact —
   * and the model only sees `file_not_found`.
   *
   * The sandbox is first compared with the network policy as it is now
   * (checkAtTurnStart), as the first operation of a turn does. A turn that uses
   * no tool does not run that check, and without it each such turn would keep a
   * sandbox alive, with the processes that run in it, on a network that the
   * tenant has since narrowed. A sandbox that matches is confirmed for this turn,
   * so the first operation reads nothing again. A sandbox that does not match is
   * killed and not replaced: the next operation creates its replacement. When
   * the check cannot be made, the lifetime is not extended.
   *
   * Deliberately a no-op when the sandbox has not been created: extending
   * would force creation and destroy the laziness that keeps chat-only
   * sessions free. Failures are swallowed — a turn must not fail because the
   * lifetime could not be extended, and if the sandbox is already gone,
   * withSandbox recovers on the next op.
   */
  async extendTimeout(): Promise<void> {
    if (this.killed) return;
    try {
      const turn = this.currentTurn();
      await this.reconcileSandbox();
      this.requireLive(turn);
      const bound = this.sandboxPromise;
      if (!bound) return;
      const sandbox = await bound;
      this.requireLive(turn);
      if (this.confirmed?.sandbox !== sandbox || this.confirmed.turn !== turn) {
        const verdict = await this.checkAtTurnStart(sandbox, turn);
        this.requireLive(turn);
        if (verdict !== "match") {
          await this.retireSandbox(bound, sandbox, verdict === "gone" ? "expired" : "network_policy", turn);
          return;
        }
        this.confirmed = { sandbox, turn };
      }
      await sandbox.setTimeout(this.options.sandboxTimeoutMs);
    } catch (err: unknown) {
      this.options.logger.warn(
        { err, sessionId: this.options.sessionId, sandboxId: this.sandboxId },
        "Failed to extend Deep Agents E2B sandbox lifetime; it may expire mid-turn"
      );
    }
  }

  async kill(): Promise<void> {
    this.killed = true;
    const pending = this.sandboxPromise;
    this.sandboxPromise = null;
    if (!pending || this.options.sandboxBinding) return;
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

/** A request to the provider that got no answer in time. It says nothing for good about the sandbox. */
class ProviderRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the provider did not answer a request within ${timeoutMs} ms`);
    this.name = "ProviderRequestTimeoutError";
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
