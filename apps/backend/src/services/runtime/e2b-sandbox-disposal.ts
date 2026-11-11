// Kills a sandbox that a session gave up. Archive, delete and purge take the sandbox id
// from the session row in the transaction that changes the status and clears the record
// (services/session-store.ts). A security change of the owner's account does the same in
// the transaction that changes the security version (releaseAccountSandboxes in
// services/session-execution-store.ts). After that transaction no runtime can adopt the
// sandbox: the record is empty, and the transaction stopped the execution lease. So this
// kill needs no lease check, and any replica can send it.
//
// It kills by id and sends no connect: a connect sends a new lifetime for the sandbox.
// It makes up to four tries inside one deadline, as the kill of a replaced sandbox does
// (deep-agents-e2b-backend.ts), and it never throws. A kill that still fails is logged
// as an error with the sandbox id. The sandbox then runs until its provider lifetime cap
// (E2B_SANDBOX_TIMEOUT_MS after the last turn start). Nothing tries again later: the
// session row no longer names the sandbox.

import type { FastifyBaseLogger } from "fastify";

import { loadE2bSandboxClass, type E2bSandboxClassLike } from "./e2b-sandbox.js";

/**
 * - killed: the provider ended the sandbox.
 * - not_found: the provider did not have it. It expired, or an earlier kill ended it.
 * - failed: every try failed. The sandbox runs until its lifetime cap.
 * - skipped: E2B is not configured, so nothing was sent (DeepAgentsRuntimeAdapter).
 */
export type SandboxDisposalOutcome = "killed" | "not_found" | "failed" | "skipped";

/** A sandbox that a lifecycle or security change took from a session. The tenant and the session are for the log. */
export type ReleasedSandbox = { tenantId: string; sessionId: string; sandboxId: string };

export type E2bSandboxDisposalOptions = {
  apiKey: string;
  /** The longest time for one kill request (E2B_NETWORK_REQUEST_TIMEOUT_MS). */
  requestTimeoutMs: number;
  /** The longest time for all the tries of one disposal (E2B_NETWORK_CONFIRM_TIMEOUT_MS). */
  deadlineMs: number;
  logger: Pick<FastifyBaseLogger, "info" | "error">;
  /** Test-only injection of the (dynamically imported) Sandbox class. */
  loadSandboxClass?: () => Promise<Pick<E2bSandboxClassLike, "kill">>;
  /** Test-only: waits before each new try. */
  retryBackoffMs?: readonly number[];
};

/** Waits before the second, third and fourth try, as for the kill of a replaced sandbox. */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000];

export class E2bSandboxDisposal {
  constructor(private readonly options: E2bSandboxDisposalOptions) {}

  async destroy(released: ReleasedSandbox): Promise<Exclude<SandboxDisposalOutcome, "skipped">> {
    const { sessionId, sandboxId } = released;
    const deadline = Date.now() + this.options.deadlineMs;
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    let lastError: unknown;
    let tries = 0;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      if (attempt > 0) await wait(Math.min(backoffMs[attempt - 1]!, deadline - Date.now()));
      const left = deadline - Date.now();
      // No try starts after the deadline.
      if (left <= 0) break;
      tries += 1;
      try {
        const outcome = await this.killOnce(sandboxId, Math.min(this.options.requestTimeoutMs, left))
          ? "killed" : "not_found";
        this.options.logger.info({ sessionId, sandboxId, outcome }, "The released sandbox of a session is gone");
        return outcome;
      } catch (error) {
        lastError = error;
      }
    }
    this.options.logger.error(
      { err: lastError, sessionId, sandboxId, tries },
      "Failed to kill the released sandbox of a session after retries; it runs until the provider expires it"
    );
    return "failed";
  }

  /**
   * One kill request. The limit goes to the SDK, which cancels the request and its own
   * retries of a 429, 502 or 503. It also bounds the wait here, so an SDK call that
   * ignores the limit cannot hold the disposal.
   */
  private async killOnce(sandboxId: string, timeoutMs: number): Promise<boolean> {
    const Sandbox = await (this.options.loadSandboxClass ?? loadE2bSandboxClass)();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`the provider did not answer the kill within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const pending = Promise.resolve(Sandbox.kill(sandboxId, {
        apiKey: this.options.apiKey, requestTimeoutMs: timeoutMs, signal: controller.signal
      }));
      // A request that was given up can still fail later. That must not be an unhandled rejection.
      pending.catch(() => {});
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
