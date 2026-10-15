// Minimal slice of http.ServerResponse used by the streaming writer.
export type RawSseResponse = {
  write(chunk: string): boolean;
  end(): void;
  once?(event: "drain", listener: () => void): unknown;
  on?(event: "close", listener: () => void): unknown;
  writableEnded?: boolean;
  destroyed?: boolean;
};

/** Writes SSE frames with backpressure and disconnect handling. */
export class SseWriter {
  private closed = false;
  private readonly onCloseCallbacks = new Set<() => void>();

  constructor(private readonly raw: RawSseResponse) {
    raw.on?.("close", () => {
      if (this.closed) return;
      this.closed = true;
      for (const callback of this.onCloseCallbacks) callback();
    });
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

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.onCloseCallbacks.delete(finish);
        resolve();
      };
      this.raw.once!("drain", finish);
      this.onClose(finish);
    });
  }

  end(): void {
    if (this.isClosed) return;
    this.raw.end();
  }
}
