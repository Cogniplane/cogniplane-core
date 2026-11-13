"use client";

// The browser session coordinator. It owns the session token, the shared
// refresh, the network refresh and the queue of session changes.
// api-client.ts makes the one instance and keeps the public exports; import
// those, not this file. This file knows no React, no HTTP and no sign-in
// policy. Like api-client.ts, it must not run on the server: its state would
// be shared by all requests of the Node process.
//
// ---- The session token, in order ----
//
// Different writers change the session token. A refresh renews it. A sign-in
// or an account change (a new password, a first second factor) starts a new
// session. A sign-out ends it. Without an order, the last answer wins: a late
// answer for an older session can replace a newer session, and a late
// /auth/refresh answer can set or delete the refresh cookie of a newer one.
// Two rules give the order:
//
// 1. The session-change gate. A call whose answer sets or deletes the refresh
//    cookie runs in changeSession and holds the gate while it runs. A refresh
//    waits until no session change runs before it sends the cookie, and a
//    session change waits for a refresh that is on the wire. Thus no refresh
//    sends a cookie that a running session change replaces. A refresh that
//    waited uses the token that the session change installed, and sends
//    nothing.
// 2. The session epoch. It changes when a new session starts in memory or the
//    session ends, not when a refresh renews the token. A writer reads it
//    before its call. If it is different after the call, the answer is for an
//    older session, and the writer must not apply it.
//
// Both waits have a time limit. A session change waits for a refresh on the
// wire at most REFRESH_ATTEMPTS × REFRESH_TIME_LIMIT_MS, and a sign-out does
// not wait: it stops the refresh. A stopped or timed-out refresh is aborted,
// so an answer that did not arrive cannot set its cookie later.
//
// ---- Who owns what ----
//
// - The token: the token, the epoch, a count of token writes, the listeners
//   and the last installation of a session change.
// - The refresh demand: the promise that refreshAccessToken gives to all its
//   callers. It waits at the gate, then starts or joins the network refresh.
// - The network refresh: the one /auth/refresh operation, with its stop
//   controller and the epoch of its start. It is separate from the demand: a
//   demand can wait at the gate while the gate holder refreshes after a 401.
//   It can also run on after the session change that started it ends.
// - The queue: the count of admitted changes, the gate, the tail of the FIFO
//   chain, the controllers that a sign-out can cancel, and the send guard.
//
// The order of statements in this file is part of the contract. Do not add an
// await between a gate check and the start of the network refresh, and do not
// change the order of admission or release.

/**
 * Sends /auth/refresh once. It must give `signal` to its fetch and change
 * nothing after the signal aborts.
 */
export type TokenRefresher = (signal: AbortSignal) => Promise<string | null>;

/**
 * The time limit of one /auth/refresh attempt. When it passes, the attempt is
 * aborted and the refresh sends the cookie once more. The server can have
 * rotated the cookie while the answer did not arrive. For 60 seconds after a
 * rotation, the server answers the same cookie with the same result
 * (refresh-token-store.ts in the backend); after that, the old cookie is
 * reuse, which ends the session. The second attempt is sent inside that
 * window, and both attempts end within REFRESH_ATTEMPTS × this limit.
 */
export const REFRESH_TIME_LIMIT_MS = 15_000;
/** The first attempt, and one more after a time-out. */
export const REFRESH_ATTEMPTS = 2;
const TIMED_OUT = Symbol("refresh timed out");

/**
 * The time limit of a session-changing call. When it passes, the call is
 * aborted and the gate opens. If its answer had not arrived, its Set-Cookie
 * does not apply, so a late answer cannot replace a newer cookie. If the
 * headers had arrived (the body or the parse was late), the browser already
 * has the new cookie, and the next refresh uses it.
 */
export const SESSION_CHANGE_TIME_LIMIT_MS = 30_000;

/** A session-changing call that did not answer in its time limit. */
export class SessionChangeTimeoutError extends Error {
  constructor() {
    super("The session change did not answer in time.");
    this.name = "SessionChangeTimeoutError";
  }
}

/**
 * The send of a session change. `signal` aborts at the time limit or when a
 * sign-out cancels the change. `refreshNow` refreshes without the gate, for a
 * 401 inside this send.
 */
export type SessionChangeSend<T> = (signal: AbortSignal, refreshNow: () => Promise<string | null>) => Promise<T>;

export type SessionChangeOptions = { stopRefresh?: boolean; interruptible?: boolean };

/** A closed gate always has the promise that waiters await and its resolver. */
type Gate =
  | { readonly closed: false }
  | { readonly closed: true; readonly opened: Promise<void>; readonly open: () => void };

const OPEN_GATE: Gate = { closed: false };

function closedGate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed: true, opened, open };
}

/** The /auth/refresh operation on the wire. */
type NetworkRefresh = {
  readonly result: Promise<string | null>;
  /** A sign-out aborts it. */
  readonly stop: AbortController;
  /** The session epoch when the operation started. */
  readonly epoch: number;
  readonly generation: number;
};

/** The shared refresh of refreshAccessToken. */
type RefreshDemand =
  | { readonly phase: "idle" }
  /** Waits at the gate. `writes` is the count of token writes at its start. */
  | { readonly phase: "waiting"; readonly result: Promise<string | null>; readonly generation: number; readonly writes: number }
  /** Started or joined `network`. */
  | { readonly phase: "sending"; readonly result: Promise<string | null>; readonly generation: number; readonly network: NetworkRefresh };

const IDLE_DEMAND: RefreshDemand = { phase: "idle" };

/** A session change from its admission to its release. */
type Admission = {
  readonly generation: number;
  /** Set for an interruptible change: a sign-out aborts it. */
  readonly interrupt: AbortController | null;
  /** Settles the queue position of this change, so that the next one starts. */
  readonly release: () => void;
};

export class SessionCoordinator {
  // The token.
  private token: string | null = null;
  private epoch = 0;
  /** Counts every token write, also a refresh. */
  private tokenWrites = 0;
  private readonly listeners = new Set<() => void>();
  /** The token that the last session change installed, and its epoch. */
  private lastInstall: { token: string; epoch: number } | null = null;

  // The refresh.
  private refresher: TokenRefresher | null = null;
  private demand: RefreshDemand = IDLE_DEMAND;
  private network: NetworkRefresh | null = null;

  // The queue.
  /** Session changes that wait or run. */
  private queued = 0;
  private gate: Gate = OPEN_GATE;
  /** Settles when the last session change in the queue ends. */
  private tail: Promise<void> = Promise.resolve();
  /** True while the synchronous part of a session change's send runs. */
  private sendStarting = false;
  /** Callback exchanges that a sign-out can cancel. */
  private readonly interruptible = new Set<AbortController>();

  /**
   * Changes at each test reset. Work that started in an older generation can
   * settle and clean up its own resources, but it changes no state of the
   * newer one. Production code does not reset.
   */
  private generation = 0;

  getToken(): string | null {
    return this.token;
  }

  getEpoch(): number {
    return this.epoch;
  }

  /** Writes the token of the session in memory, as a refresh does. */
  writeToken(token: string | null): void {
    this.token = token;
    this.tokenWrites += 1;
    for (const listener of this.listeners) listener();
  }

  /** Starts a new session in memory (a token) or ends it (null). Returns the new epoch. */
  replaceSession(token: string | null): number {
    this.epoch += 1;
    this.writeToken(token);
    return this.epoch;
  }

  installedEpoch(token: string): number | null {
    return this.lastInstall?.token === token ? this.lastInstall.epoch : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setRefresher(refresher: TokenRefresher): void {
    this.refresher = refresher;
  }

  /**
   * Opens the gate and forgets the token, the epoch, the refresher, the
   * refresh and the queue. Listeners stay. It calls no listener and aborts no
   * controller: work from before the reset settles as it would, without an
   * effect on the new generation.
   */
  resetForTests(): void {
    this.generation += 1;
    this.openGate();
    this.token = null;
    this.epoch = 0;
    this.tokenWrites = 0;
    this.lastInstall = null;
    this.refresher = null;
    this.demand = IDLE_DEMAND;
    this.network = null;
    this.queued = 0;
    this.tail = Promise.resolve();
    this.sendStarting = false;
    this.interruptible.clear();
  }

  // ---- The refresh ----

  /**
   * Gives all callers the same refresh until it settles. With an open gate,
   * the refresher starts in the first call, before it returns.
   */
  requestRefresh(): Promise<string | null> {
    if (this.demand.phase !== "idle") return this.demand.result;
    const generation = this.generation;
    const writes = this.tokenWrites;
    const startsAtOnce = !this.mustWait(generation);
    const result: Promise<string | null> = this.refreshAfterChanges(generation, writes)
      .finally(() => this.finishRefreshDemand(result));
    // With an open gate, the call above started or joined the network
    // refresh before it returned.
    const network = this.network;
    this.demand = startsAtOnce && network
      ? { phase: "sending", result, generation, network }
      : { phase: "waiting", result, generation, writes };
    return result;
  }

  private async refreshAfterChanges(generation: number, writes: number): Promise<string | null> {
    while (this.mustWait(generation)) await this.gateOpened();
    // A test reset came while this refresh waited.
    if (generation !== this.generation) return null;
    // A session change installed a token while this refresh waited (or ended
    // the session). Its cookie is new, so a refresh is not necessary.
    if (this.tokenWrites !== writes) return this.token;
    // No await between the checks above and this start.
    const network = this.startOrJoinNetworkRefresh();
    // One demand exists at a time in a generation. If a demand of this
    // generation waits, it is this one: it now sends.
    if (this.demand.phase === "waiting" && this.demand.generation === generation) {
      this.demand = { phase: "sending", result: this.demand.result, generation, network };
    }
    return network.result;
  }

  private mustWait(generation: number): boolean {
    return generation === this.generation && this.queued > 0;
  }

  private finishRefreshDemand(result: Promise<string | null>): void {
    if (this.demand.phase !== "idle" && this.demand.result === result) this.demand = IDLE_DEMAND;
  }

  /**
   * Sends /auth/refresh now, once for all callers. Only a refresh demand after
   * its gate wait and a holder of the gate call it. It does not depend on the
   * signal of the session change that started it, so it can outlive that
   * change.
   */
  private startOrJoinNetworkRefresh(): NetworkRefresh {
    if (this.network) return this.network;
    const stop = new AbortController();
    const epoch = this.epoch;
    const generation = this.generation;
    const result = this.sendRefreshAttempts(stop.signal, epoch, generation)
      .finally(() => this.finishNetworkRefresh(network));
    const network: NetworkRefresh = { result, stop, epoch, generation };
    this.network = network;
    return network;
  }

  private async sendRefreshAttempts(stop: AbortSignal, epoch: number, generation: number): Promise<string | null> {
    const refresher = this.refresher;
    if (!refresher) return null;
    let token: string | null = null;
    for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt += 1) {
      const answer = await attemptInTimeLimit(refresher, stop);
      if (answer !== TIMED_OUT) {
        token = answer;
        break;
      }
    }
    // A sign-out stopped this refresh: its answer applies to nothing.
    if (stop.aborted) return null;
    // A test reset came while this refresh ran.
    if (generation !== this.generation) return null;
    // A new session started, or the session ended, while this refresh ran.
    // Its answer is for the older session: keep the newer one.
    if (this.epoch !== epoch) return this.token;
    if (token) this.writeToken(token);
    return token;
  }

  private finishNetworkRefresh(network: NetworkRefresh): void {
    if (this.network === network) this.network = null;
  }

  // ---- The queue ----

  /**
   * Runs `send` while it holds the session-change gate. Session changes run
   * one at a time, in the order of their calls. api-client.ts documents the
   * contract of its changeSession export.
   */
  async changeSession<T>(
    send: SessionChangeSend<T>,
    install?: (result: T) => string | null | undefined,
    options: SessionChangeOptions = {}
  ): Promise<T> {
    const { admission, predecessor } = this.admitChange(options);
    try {
      // Start the change: wait for the changes ahead and for a refresh on
      // the wire. These awaits stay in this function, so that no extra step
      // comes between the end of a wait and the send.
      await predecessor;
      this.endIfReset(admission);
      // A refresh on the wire ends first: its answer can set or delete the
      // refresh cookie. A sign-out stops it.
      const network = this.network;
      if (network) {
        if (options.stopRefresh) network.stop.abort();
        await network.result.catch(() => null);
        this.endIfReset(admission);
      }
      // Read the epoch after the waits, just before the send.
      const epoch = this.epoch;
      const result = await this.sendInTimeLimit(admission, send);
      this.installChangeResult(admission, epoch, result, install);
      return result;
    } finally {
      this.releaseChange(admission);
    }
  }

  /** A change that a test reset passed while it waited does not send. */
  private endIfReset(admission: Admission): void {
    if (admission.generation !== this.generation) throw new Error("The session coordinator was reset.");
  }

  /**
   * Admits a change before any await, in this order: the send guard, the
   * gate, the sign-out cancellation, the interrupt, the count and the tail.
   * Abort listeners run during the cancellation, before this change is in the
   * count, so a callback admitted later is not cancelled.
   */
  private admitChange(options: SessionChangeOptions): { admission: Admission; predecessor: Promise<void> } {
    if (this.sendStarting) {
      throw new Error("changeSession was called inside a session change. Use the request that changeSession gives to send.");
    }
    if (this.queued === 0) this.gate = closedGate();
    if (options.stopRefresh) this.cancelForSignOut();
    const interrupt = options.interruptible ? new AbortController() : null;
    if (interrupt) this.interruptible.add(interrupt);
    this.queued += 1;
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { admission: { generation: this.generation, interrupt, release }, predecessor };
  }

  /**
   * The first of the two cancellation points of a sign-out, at its admission:
   * it aborts the refresh on the wire and every admitted callback. The second
   * point is its turn in changeSession, where it aborts the refresh on the
   * wire again. Cancelled changes keep their place in the queue.
   */
  private cancelForSignOut(): void {
    this.network?.stop.abort();
    for (const interrupt of this.interruptible) interrupt.abort(new Error("Sign-out cancelled the callback"));
  }

  /**
   * Installs the token of the answer before the gate opens. It installs
   * nothing when the epoch changed during the call, also when the installer
   * itself changed it. The installation adds one to the epoch.
   */
  private installChangeResult<T>(
    admission: Admission,
    epoch: number,
    result: T,
    install: ((result: T) => string | null | undefined) | undefined
  ): void {
    if (!this.isSameSession(admission, epoch)) return;
    const token = install?.(result);
    if (token === undefined || !this.isSameSession(admission, epoch)) return;
    const installed = this.replaceSession(token);
    this.lastInstall = token === null ? null : { token, epoch: installed };
  }

  private isSameSession(admission: Admission, epoch: number): boolean {
    return admission.generation === this.generation && this.epoch === epoch;
  }

  /**
   * Releases a change, once for each admission: removes the interrupt, takes
   * the change out of the count, opens the gate when no change is left, then
   * lets the next change in the queue start.
   */
  private releaseChange(admission: Admission): void {
    if (admission.interrupt) this.interruptible.delete(admission.interrupt);
    if (admission.generation === this.generation) {
      this.queued -= 1;
      if (this.queued === 0) this.openGate();
    }
    admission.release();
  }

  private openGate(): void {
    const gate = this.gate;
    this.gate = OPEN_GATE;
    if (gate.closed) gate.open();
  }

  private gateOpened(): Promise<void> {
    return this.gate.closed ? this.gate.opened : Promise.resolve();
  }

  /**
   * Runs `send` with SESSION_CHANGE_TIME_LIMIT_MS. The limit starts here,
   * after the waits in the queue and for the refresh on the wire.
   */
  private async sendInTimeLimit<T>(admission: Admission, send: SessionChangeSend<T>): Promise<T> {
    const stop = admission.interrupt?.signal;
    if (stop?.aborted) throw stop.reason;
    const limit = new AbortController();
    // A send that ends after a test reset gets no refresh of the new generation.
    const refreshNow = () =>
      admission.generation === this.generation ? this.startOrJoinNetworkRefresh().result : Promise.resolve(null);
    let sending: Promise<T>;
    this.sendStarting = true;
    try {
      sending = send(limit.signal, refreshNow);
    } catch (error) {
      sending = Promise.reject(error);
    } finally {
      this.sendStarting = false;
    }
    // An answer after the limit is dropped; its failure is not unhandled.
    sending.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SessionChangeTimeoutError();
        limit.abort(error);
        reject(error);
      }, SESSION_CHANGE_TIME_LIMIT_MS);
    });
    let onStop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      onStop = () => { limit.abort(stop?.reason); reject(stop?.reason); };
      if (stop?.aborted) onStop();
      else stop?.addEventListener("abort", onStop, { once: true });
    });
    try {
      return await Promise.race([sending, expired, stopped]);
    } finally {
      if (onStop) stop?.removeEventListener("abort", onStop);
      clearTimeout(timer);
    }
  }
}

/**
 * One refresh attempt in REFRESH_TIME_LIMIT_MS. Gives TIMED_OUT when the
 * limit passes, and null when `stop` aborts. Either way, the attempt's signal
 * aborts, and a later result of the refresher is ignored.
 */
async function attemptInTimeLimit(refresher: TokenRefresher, stop: AbortSignal): Promise<string | null | typeof TIMED_OUT> {
  if (stop.aborted) return null;
  const attempt = new AbortController();
  let end!: (result: null | typeof TIMED_OUT) => void;
  const ended = new Promise<null | typeof TIMED_OUT>((resolve) => {
    end = resolve;
  });
  const onStop = () => {
    attempt.abort(stop.reason);
    end(null);
  };
  stop.addEventListener("abort", onStop, { once: true });
  const timer = setTimeout(() => {
    attempt.abort(new DOMException("The refresh did not answer in time.", "TimeoutError"));
    end(TIMED_OUT);
  }, REFRESH_TIME_LIMIT_MS);
  try {
    const running = refresher(attempt.signal);
    // An answer after the limit is dropped; its failure is not unhandled.
    running.catch(() => undefined);
    return await Promise.race([running, ended]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  }
}
