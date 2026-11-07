/**
 * A simple async queue that implements the AsyncIterable protocol.
 * Consumers can `for await` over the queue to receive values as they are pushed.
 * Call `end()` to signal that no more values will be pushed.
 *
 * An optional `maxSize` can be provided to cap the internal buffer. When
 * the buffer is full, `push()` returns `false` and drops the value.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private error: Error | null = null;
  private closed = false;

  constructor(private readonly maxSize?: number) {}

  /**
   * Returns `true` if the value was accepted, `false` if the queue is closed
   * or the buffer has reached `maxSize`.
   */
  push(value: T): boolean {
    if (this.closed) {
      return false;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return true;
    }

    if (this.maxSize !== undefined && this.values.length >= this.maxSize) {
      return false;
    }

    this.values.push(value);
    return true;
  }

  end(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ value: undefined, done: true });
    }
  }

  /**
   * Signal that the producer failed. The queue rejects a consumer that waits in
   * `next()` at once, and later `next()` calls throw the same error. Without
   * this, a consumer waits forever after a producer error, such as a DB error in
   * a runtime request handler. The turn then hangs and keeps its active-turn slot.
   *
   * The first error wins. The queue closes, so it accepts no later value. The
   * queue drops buffered values, because `next()` throws before it returns them.
   */
  setError(error: Error): void {
    if (this.closed || this.error) {
      return;
    }

    this.error = error;
    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) {
      throw this.error;
    }

    if (this.values.length) {
      return { value: this.values.shift() as T, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => this.next()
    };
  }
}
