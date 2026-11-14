import type { FastifyInstance } from "fastify";

/** The slice of http.ServerResponse that the registry uses. */
export type TrackedSseResponse = {
  end(): void;
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
  destroyed: boolean;
};

/**
 * The open SSE responses of one app. Hijacked replies are outside Fastify's
 * request tracking, and an open stream keeps `server.close()` waiting. The
 * shutdown closes them here after the turn drain, so the HTTP server can close
 * and the onClose cleanup runs.
 *
 * Closing a response ends only this connection. Each stream releases its own
 * resources on the close event (SseWriter.onClose). A viewer of a turn that
 * another replica runs disconnects its bus reader; that turn continues.
 */
export class SseConnections {
  private readonly open = new Set<TrackedSseResponse>();
  private closing: Promise<void> | null = null;

  get size(): number {
    return this.open.size;
  }

  /**
   * Tracks a response until it emits close. After close() started, the
   * response is destroyed at once: a stream that a request opens during the
   * shutdown cannot keep the server open. Destroy, not end: Node drops a
   * later write to a destroyed response, but a write after end() emits an
   * error event, which crashes the process when the route writes to the raw
   * response directly.
   */
  track(raw: TrackedSseResponse): void {
    if (raw.destroyed) return;
    if (this.closing) {
      raw.destroy();
      return;
    }
    this.open.add(raw);
    raw.once("close", () => this.open.delete(raw));
  }

  /**
   * Ends every open response, and destroys a response that has not closed
   * after `graceMs` (a client that does not read). Resolves when all closed.
   */
  close(graceMs: number): Promise<void> {
    if (!this.closing) {
      this.closing = Promise.all([...this.open].map((raw) => endWithin(raw, graceMs))).then(() => undefined);
    }
    return this.closing;
  }
}

function endWithin(raw: TrackedSseResponse, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!raw.destroyed) raw.destroy();
      resolve();
    }, graceMs);
    timer.unref?.();
    raw.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    raw.end();
  });
}

/** Adds the registry to the app once. Call before the routes register. */
export function registerSseConnections(app: FastifyInstance): SseConnections {
  if (!app.hasDecorator("sseConnections")) app.decorate("sseConnections", new SseConnections());
  return app.sseConnections;
}

/** The registry of the app, if the app has one. Route tests can omit it. */
export function sseConnectionsOf(app: FastifyInstance): SseConnections | undefined {
  return app.hasDecorator("sseConnections") ? app.sseConnections : undefined;
}
