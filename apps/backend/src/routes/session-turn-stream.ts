// Replay and live events of the turn that runs on a session, for
// `GET /sessions/:id/connect`, which streams the saved history first.
//
// A local turn runs in this process and has a bounded TurnEventLog. A remote
// turn runs on another replica, which mirrors its events to the Redis turn bus.
// Both streams check session access again while they run.

import { EventType } from "@ag-ui/client";
import { CogniplaneCustomEventSchema } from "@cogniplane/shared-types";
import type { FastifyBaseLogger } from "fastify";

import type { SseWriter } from "../services/sse-writer.js";
import type { SequencedTurnEvent, TurnEventLog } from "../services/turn-event-log.js";
import type { TurnCoordinationBus, TurnKey } from "../services/turn-coordination-bus.js";

// The events that a stream can hold before the client reads them. A client
// that reads too slowly loses its stream instead of process memory.
const MAX_PENDING_BYTES = 1_000_000;
const HEARTBEAT_MS = 20_000;

export function turnEventFrame(entry: SequencedTurnEvent): string {
  return `id: ${entry.sequence}\ndata: ${JSON.stringify(entry.event)}\n\n`;
}

/** Holds local turn events from the moment of subscription until the stream
 *  writes them. It does not hold more than MAX_PENDING_BYTES. */
export class LocalTurnQueue {
  readonly pending: SequencedTurnEvent[] = [];
  /** The turn ended: the log sends no more events. */
  closed = false;
  /** The client did not read fast enough. The queue dropped its events. */
  overflowed = false;
  private bytes = 0;
  private notify?: () => void;
  private subscription: { unsubscribe(): void } | null = null;

  /** Null when the log cannot replay from the start of the turn: the turn
   *  ended, or the bounded log already dropped its first events. */
  static open(log: TurnEventLog): LocalTurnQueue | null {
    const queue = new LocalTurnQueue();
    const subscription = log.subscribe(0, (entry) => {
      if (queue.overflowed) return;
      if (entry) queue.push(entry);
      else queue.closed = true;
      queue.notify?.();
    });
    if (!subscription) return null;
    queue.subscription = subscription;
    for (const entry of subscription.replay) queue.push(entry);
    return queue;
  }

  /** `notify` runs after each new event, at the end of the turn, and on overflow. */
  watch(notify: () => void): void {
    this.notify = notify;
  }

  shift(): SequencedTurnEvent | undefined {
    const entry = this.pending.shift();
    if (entry) this.bytes -= Buffer.byteLength(turnEventFrame(entry));
    return entry;
  }

  close(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  private push(entry: SequencedTurnEvent): void {
    if (this.overflowed) return;
    const frameBytes = Buffer.byteLength(turnEventFrame(entry));
    if (this.bytes + frameBytes > MAX_PENDING_BYTES) {
      this.overflowed = true;
      this.pending.length = 0;
      this.bytes = 0;
      this.close();
      return;
    }
    this.pending.push(entry);
    this.bytes += frameBytes;
  }
}

export type TurnSource =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "local"; queue: LocalTurnQueue }
  | { kind: "remote"; turn: TurnKey; replay: SequencedTurnEvent[] };

type CurrentOwner = (tenantId: string, sessionId: string) => Promise<{ executionId: string } | null>;

export type TurnSourceStores = {
  activeTurns?: { eventLog(sessionId: string, tenantId: string): TurnEventLog | undefined };
  executions?: { currentOwner?: CurrentOwner };
  turnBus?: Pick<TurnCoordinationBus, "replay" | "waitForEvents" | "reader">;
};

/** Finds the turn that runs on a session and starts to capture its events.
 *  Call this before any history read: the capture then holds every event
 *  that the read can miss. */
export async function openTurnSource(
  stores: TurnSourceStores,
  scope: { tenantId: string; sessionId: string },
  log: FastifyBaseLogger
): Promise<TurnSource> {
  const localLog = stores.activeTurns?.eventLog(scope.sessionId, scope.tenantId);
  if (localLog) {
    const queue = LocalTurnQueue.open(localLog);
    if (!queue || queue.overflowed) return { kind: "unavailable" };
    return { kind: "local", queue };
  }
  const owner = await stores.executions?.currentOwner?.(scope.tenantId, scope.sessionId);
  if (!owner) return { kind: "none" };
  if (!stores.turnBus) return { kind: "unavailable" };
  const turn = { ...scope, executionId: owner.executionId };
  let replay: SequencedTurnEvent[] | null;
  try {
    replay = await stores.turnBus.replay(turn, 0);
  } catch (error) {
    log.warn({ err: error, sessionId: scope.sessionId }, "Remote event replay unavailable");
    return { kind: "unavailable" };
  }
  if (!replay) return { kind: "unavailable" };
  return { kind: "remote", turn, replay };
}

/** The events that the source holds now, before the stream writes them. */
export function capturedEvents(source: TurnSource): SequencedTurnEvent[] {
  if (source.kind === "local") return source.queue.pending;
  if (source.kind === "remote") return source.replay;
  return [];
}

/** The saved assistant row that the captured turn rebuilds, from its
 *  turn_started event. Undefined while the turn is still in setup. */
export function turnStartedRowId(events: SequencedTurnEvent[]): string | undefined {
  for (const { event } of events) {
    if (event.type !== EventType.CUSTOM) continue;
    const parsed = CogniplaneCustomEventSchema.safeParse(event);
    if (parsed.success && parsed.data.name === "turn_started") return parsed.data.value.messageId;
  }
  return undefined;
}

/** Adds the remote events that arrived after the first replay, also when
 *  that replay was empty. A failed read keeps the current replay; the live
 *  loop then reads from its end. */
export async function catchUpRemote(
  bus: Pick<TurnCoordinationBus, "replay">,
  source: Extract<TurnSource, { kind: "remote" }>
): Promise<void> {
  try {
    const more = await bus.replay(source.turn, source.replay.at(-1)?.sequence ?? 0);
    if (more) source.replay.push(...more);
  } catch {
    // The live loop reads the same events.
  }
}

/** Releases a source that the route does not stream. */
export function closeTurnSource(source: TurnSource): void {
  if (source.kind === "local") source.queue.close();
}

type StreamOptions = {
  writer: SseWriter;
  /** True while the requester can still read the session. */
  canRead: () => Promise<boolean>;
  log: FastifyBaseLogger;
  sessionId: string;
};

/** Writes the local turn until it ends, the client leaves, the client reads
 *  too slowly, or the requester loses access. */
export async function streamLocalTurn(queue: LocalTurnQueue, options: StreamOptions): Promise<void> {
  const { writer, canRead } = options;
  await new Promise<void>((resolve) => {
    let done = false;
    let writing = false;
    let checkingAccess = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      queue.close();
      writer.end();
      resolve();
    };
    const heartbeat = setInterval(() => {
      void writer.write(": keep-alive\n\n");
      if (checkingAccess || done) return;
      checkingAccess = true;
      void canRead()
        .then((readable) => { if (!readable) finish(); })
        .catch(() => finish())
        .finally(() => { checkingAccess = false; });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    writer.onClose(finish);
    const pump = () => {
      if (queue.overflowed) {
        finish();
        return;
      }
      if (writing || done) return;
      writing = true;
      void (async () => {
        try {
          while (queue.pending.length && !writer.isClosed) {
            await writer.write(turnEventFrame(queue.shift()!));
          }
        } finally {
          writing = false;
          if (queue.closed || queue.overflowed || writer.isClosed) finish();
          else if (queue.pending.length) pump();
        }
      })();
    };
    queue.watch(pump);
    pump();
  });
}

/** Writes the remote turn from the turn bus. The stream ends at the terminal
 *  event, at a gap in the bus, when another execution owns the session, or
 *  when the requester loses access. */
export async function streamRemoteTurn(
  source: Extract<TurnSource, { kind: "remote" }>,
  // The store object, not its method: SessionExecutionStore.currentOwner
  // reads its pool through `this`.
  stores: { turnBus: Pick<TurnCoordinationBus, "waitForEvents" | "reader"> } & Pick<TurnSourceStores, "executions">,
  options: StreamOptions
): Promise<void> {
  const { writer, canRead, log, sessionId } = options;
  const { turn } = source;
  const reader = stores.turnBus.reader();
  let replay: SequencedTurnEvent[] | null = source.replay;
  let after = 0;
  let closed = false;
  writer.onClose(() => {
    closed = true;
    reader.disconnect();
  });
  try {
    while (!closed && replay) {
      if (!(await canRead())) break;
      for (const entry of replay) {
        if (entry.sequence <= after) continue;
        await writer.write(turnEventFrame(entry));
        after = entry.sequence;
        if (entry.event.type === EventType.RUN_FINISHED || entry.event.type === EventType.RUN_ERROR) {
          closed = true;
          break;
        }
      }
      if (closed || writer.isClosed) break;
      replay = await stores.turnBus.waitForEvents(reader, turn, after);
      if (replay?.length === 0) {
        const live = await stores.executions?.currentOwner?.(turn.tenantId, turn.sessionId);
        if (!live || live.executionId !== turn.executionId) break;
        await writer.write(": keep-alive\n\n");
      }
    }
  } catch (error) {
    if (!closed) log.warn({ err: error, sessionId }, "Remote event stream ended");
  } finally {
    reader.disconnect();
    writer.end();
  }
}
