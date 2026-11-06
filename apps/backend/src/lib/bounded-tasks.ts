// Work that starts after a request was answered, with a cap on how much of
// it can wait at once. A burst past the cap is dropped instead of queued, so
// it cannot grow memory or hold database connections without end. At
// shutdown, close() refuses new work and drain() waits for the admitted work,
// so it does not lose its database pools half way.

export class BoundedTasks {
  private readonly running = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly max: number) {}

  /**
   * Admits `work` and starts it on a later turn of the event loop, after the
   * current response is on its way. False, and nothing started, at the cap or
   * after close().
   */
  run(work: () => Promise<unknown>, onError: (error: unknown) => void): boolean {
    if (this.closed || this.running.size >= this.max) return false;
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch(onError)
      .finally(() => { this.running.delete(task); });
    this.running.add(task);
    return true;
  }

  get size(): number {
    return this.running.size;
  }

  /** No new work after this. */
  close(): void {
    this.closed = true;
  }

  /** Waits up to `budgetMs` for the admitted work. True when none is left. */
  async drain(budgetMs: number): Promise<boolean> {
    if (this.running.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      Promise.allSettled([...this.running]).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); })
    ]);
    clearTimeout(timer);
    return done && this.running.size === 0;
  }
}
