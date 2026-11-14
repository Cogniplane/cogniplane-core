import type { Redis } from "ioredis";

import { RedisSubscription, type RedisSubscriptionLogger } from "../lib/redis-subscription.js";
import type { SequencedTurnEvent } from "./turn-event-log.js";

const STOP_CHANNEL = "cogniplane:turn-stop:v1";
// `waitForEvents` blocks on the server for up to XREAD_BLOCK_MS. The reader's
// command limit is longer by a margin, so a normal empty wait returns null
// from Redis and is not a timeout. The shared client limit (2 seconds) would
// end every such wait early.
const XREAD_BLOCK_MS = 10_000;
export const READER_COMMAND_TIMEOUT_MS = XREAD_BLOCK_MS + 2_000;
const MAX_EVENTS = 1_000;
const MAX_BYTES = 1_000_000;

export type TurnKey = { tenantId: string; sessionId: string; executionId: string };
export type StopSignal = TurnKey & { ownerId: string; userId: string };

function streamKey(turn: TurnKey): string {
  return `cogniplane:turn-events:v1:${turn.tenantId}:${turn.sessionId}:${turn.executionId}`;
}

const APPEND_SCRIPT = `
local id = ARGV[1] .. '-0'
redis.call('XADD', KEYS[1], id, 'event', ARGV[2])
redis.call('HSET', KEYS[2], id, ARGV[3])
local total = redis.call('INCRBY', KEYS[3], ARGV[3])
while redis.call('XLEN', KEYS[1]) > tonumber(ARGV[4]) or total > tonumber(ARGV[5]) do
  local first = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)[1]
  if not first then break end
  local size = tonumber(redis.call('HGET', KEYS[2], first[1]) or '0')
  redis.call('XDEL', KEYS[1], first[1])
  redis.call('HDEL', KEYS[2], first[1])
  total = redis.call('DECRBY', KEYS[3], size)
end
redis.call('EXPIRE', KEYS[1], 3600)
redis.call('EXPIRE', KEYS[2], 3600)
redis.call('EXPIRE', KEYS[3], 3600)
return 1`;

type StreamRow = [string, string[]];

function parseRows(rows: StreamRow[]): SequencedTurnEvent[] {
  return rows.flatMap(([id, fields]) => {
    const index = fields.indexOf("event");
    if (index < 0) return [];
    const event = JSON.parse(fields[index + 1]!) as SequencedTurnEvent["event"];
    return [{ sequence: Number(id.split("-")[0]), event, bytes: Buffer.byteLength(fields[index + 1]!) }];
  });
}

function hasGap(after: number, entries: SequencedTurnEvent[]): boolean {
  let expected = after + 1;
  for (const entry of entries) {
    if (entry.sequence !== expected) return true;
    expected += 1;
  }
  return false;
}

export class TurnCoordinationBus {
  private stopSubscription?: RedisSubscription;

  constructor(
    private readonly redis: Redis,
    private readonly logger: RedisSubscriptionLogger
  ) {}

  async append(turn: TurnKey, entry: SequencedTurnEvent): Promise<void> {
    const key = streamKey(turn);
    const event = JSON.stringify(entry.event);
    await this.redis.eval(APPEND_SCRIPT, 3, key, `${key}:sizes`, `${key}:total`,
      entry.sequence, event, Buffer.byteLength(event), MAX_EVENTS, MAX_BYTES);
  }

  async replay(turn: TurnKey, after: number): Promise<SequencedTurnEvent[] | null> {
    const key = streamKey(turn);
    const first = await this.redis.xrange(key, "-", "+", "COUNT", 1) as StreamRow[];
    const last = await this.redis.xrevrange(key, "+", "-", "COUNT", 1) as StreamRow[];
    if (!first.length) return after === 0 ? [] : null;
    const firstSequence = Number(first[0]![0].split("-")[0]);
    const lastSequence = Number(last[0]![0].split("-")[0]);
    if (after < firstSequence - 1 || after > lastSequence) return null;
    const entries = parseRows(await this.redis.xrange(key, `(${after}-0`, "+") as StreamRow[]);
    return hasGap(after, entries) ? null : entries;
  }

  async waitForEvents(reader: Redis, turn: TurnKey, after: number): Promise<SequencedTurnEvent[] | null> {
    const result = await reader.call("XREAD", "BLOCK", XREAD_BLOCK_MS, "COUNT", 100, "STREAMS", streamKey(turn), `${after}-0`) as
      [string, StreamRow[]] | Array<[string, StreamRow[]]> | null;
    if (!result) return [];
    const entries = parseRows(typeof result[0] === "string" ? result[1] as StreamRow[] : result[0]![1]);
    return hasGap(after, entries) ? null : entries;
  }

  reader(): Redis { return this.redis.duplicate({ commandTimeout: READER_COMMAND_TIMEOUT_MS }); }

  async publishStop(signal: StopSignal): Promise<void> {
    await this.redis.publish(STOP_CHANNEL, JSON.stringify(signal));
  }

  /**
   * Subscribes to stop signals and waits for the first attempt. The
   * subscription follows the rule in lib/redis-subscription.ts: a failure
   * does not stop the startup, and the retries run in the background. While it
   * is not subscribed, the owner replica sees a stop at its next lease
   * heartbeat (session_executions).
   */
  async subscribeStop(onStop: (signal: StopSignal) => void): Promise<void> {
    if (this.stopSubscription) return;
    const { subscription, ready } = RedisSubscription.open({
      connect: () => this.redis.duplicate(),
      channel: STOP_CHANNEL,
      name: "turn stop",
      logger: this.logger,
      onMessage: (payload) => {
        try {
          const signal = JSON.parse(payload) as StopSignal;
          if ([signal.tenantId, signal.sessionId, signal.executionId, signal.ownerId, signal.userId]
            .every(value => typeof value === "string" && value.length > 0 && value.length <= 512)) onStop(signal);
        } catch { /* Ignore malformed Redis messages. */ }
      }
    });
    this.stopSubscription = subscription;
    await ready;
  }

  /** Closes the stop subscription, also while its first attempt runs. */
  close(): void {
    this.stopSubscription?.close();
  }
}
