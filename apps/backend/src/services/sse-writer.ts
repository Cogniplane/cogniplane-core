// Minimal slice of http.ServerResponse used by the streaming writer.
export type RawSseResponse = {
  write(chunk: string): boolean;
  end(): void;
  /** Closes the connection at once. `end()` cannot finish on a socket that does not drain. */
  destroy?(): void;
  once?(event: "drain", listener: () => void): unknown;
  removeListener?(event: "drain", listener: () => void): unknown;
  on?(event: "close", listener: () => void): unknown;
  writableEnded?: boolean;
  destroyed?: boolean;
};

/**
 * The longest time a write waits for a full socket buffer to drain. A client
 * that does not read for this long loses its connection, as on a disconnect.
 * The caller then continues: an interactive turn still saves its transcript
 * and releases admission, and the client can reconnect to the running turn.
 * The value allows for slow networks and proxy buffering, and it is much
 * shorter than a turn.
 */
export const SSE_DRAIN_DEADLINE_MS = 30_000;

export type SseWriterOptions = {
  /** Overrides SSE_DRAIN_DEADLINE_MS. Tests only; production omits it. */
  drainDeadlineMs?: number;
};

type DrainWait = { promise: Promise<void>; settle: () => void };

/** Writes SSE frames with backpressure and disconnect handling. */
export class SseWriter {
  private closed = false;
  private readonly onCloseCallbacks = new Set<() => void>();
  // One wait for each full buffer. Writes that start during the wait (a
  // heartbeat, for example) share its drain listener and deadline.
  private drainWait: DrainWait | null = null;
  private readonly drainDeadlineMs: number;

  constructor(private readonly raw: RawSseResponse, options: SseWriterOptions = {}) {
    this.drainDeadlineMs = options.drainDeadlineMs ?? SSE_DRAIN_DEADLINE_MS;
    raw.on?.("close", () => this.markClosed());
  }

  get isClosed(): boolean {
    return this.closed || this.raw.writableEnded === true || this.raw.destroyed === true;
  }

  onClose(callback: () => void): void {
    if (this.closed) {
      callback();
      return;
    }
    this.onCloseCallbacks.add(callback);
  }

  async write(frame: string): Promise<void> {
    if (this.isClosed) return;
    const accepted = this.raw.write(frame);
    if (accepted || !this.raw.once) return;
    await this.waitForDrain();
  }

  end(): void {
    if (this.isClosed) return;
    this.raw.end();
  }

  /** Resolves on drain, on close, or at the deadline, whichever comes first. */
  private waitForDrain(): Promise<void> {
    if (this.drainWait) return this.drainWait.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const onDrain = (): void => wait.settle();
    const timer = setTimeout(() => this.closeStalledConnection(), this.drainDeadlineMs);
    timer.unref?.();
    const wait: DrainWait = {
      promise,
      settle: () => {
        if (this.drainWait !== wait) return;
        this.drainWait = null;
        clearTimeout(timer);
        this.raw.removeListener?.("drain", onDrain);
        resolve();
      }
    };
    this.drainWait = wait;
    this.raw.once!("drain", onDrain);
    return promise;
  }

  // The client stopped reading. Close only this connection, as a disconnect
  // does: the pending writes resolve first, and later writes do nothing.
  private closeStalledConnection(): void {
    if (this.closed) return;
    this.markClosed();
    if (this.raw.destroyed) return;
    if (this.raw.destroy) this.raw.destroy();
    else this.raw.end();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.drainWait?.settle();
    for (const callback of this.onCloseCallbacks) callback();
    this.onCloseCallbacks.clear();
  }
}
