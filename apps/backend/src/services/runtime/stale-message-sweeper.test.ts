import { test, expect } from "vitest";

import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import {
  resolveStaleMessageDeadline,
  sweepStaleAssistantMessages
} from "./stale-message-sweeper.js";

function row(messageId: string, tenantId = "tenant-1") {
  return { tenantId, sessionId: "session-1", messageId };
}

test("passes the caller's staleness deadline through to the store", async () => {
  // The deadline is the turn's wall-clock ceiling, not an arbitrary constant —
  // sweeping earlier than that would mark a LIVE turn interrupted.
  const seen: number[] = [];
  const count = await sweepStaleAssistantMessages({
    messages: {
      sweepStaleStreaming: async (olderThanMs: number) => {
        seen.push(olderThanMs);
        return [];
      }
    },
    logger: createSilentLogger(),
    staleAfterMs: 1_800_000
  });

  expect(seen).toEqual([1_800_000]);
  expect(count).toBe(0);
});

test("drains a backlog larger than one batch", async () => {
  // After a long outage the table can hold far more stale rows than one batch.
  // Stopping at the first full batch would leave the rest spinning in the UI
  // until the next sweep interval — which is the turn timeout, i.e. very long.
  const batches = [[row("a"), row("b")], [row("c")], []];
  let call = 0;
  const count = await sweepStaleAssistantMessages(
    {
      messages: {
        sweepStaleStreaming: async () => batches[call++] ?? []
      },
      logger: createSilentLogger(),
      staleAfterMs: 1_000
    },
    2
  );

  // Two full batches were requested (2 rows, then 1) — the short second batch
  // ends the loop, so exactly two calls.
  expect(call).toBe(2);
  expect(count).toBe(3);
});

test("stops after a single short batch", async () => {
  let call = 0;
  const count = await sweepStaleAssistantMessages(
    {
      messages: {
        sweepStaleStreaming: async () => {
          call += 1;
          return [row("a")];
        }
      },
      logger: createSilentLogger(),
      staleAfterMs: 1_000
    },
    500
  );

  expect(call).toBe(1);
  expect(count).toBe(1);
});

test("the deadline exceeds a turn's working budget plus several approval rounds", async () => {
  // The sweeper marks a row interrupted, so the deadline must sit beyond any
  // plausible live turn. The watchdog caps WORKING time but pauses for
  // approvals, so working time alone is not the ceiling — a turn that takes two
  // approval rounds must still be safe.
  const deadline = resolveStaleMessageDeadline({
    RUNTIME_TURN_TIMEOUT_MS: 20 * 60_000,
    APPROVAL_REQUEST_TTL_MS: 10 * 60_000
  });

  expect(deadline).not.toBeNull();
  expect(deadline!).toBeGreaterThan(20 * 60_000 + 2 * 10 * 60_000);
});

test("no deadline exists when the turn watchdog is disabled", async () => {
  // RUNTIME_TURN_TIMEOUT_MS=0 is the documented escape hatch for turns with no
  // ceiling. With no ceiling, no elapsed time distinguishes an abandoned row
  // from a live one, so the sweeper must not run at all rather than pick a
  // number and mark live turns interrupted.
  expect(
    resolveStaleMessageDeadline({
      RUNTIME_TURN_TIMEOUT_MS: 0,
      APPROVAL_REQUEST_TTL_MS: 10 * 60_000
    })
  ).toBeNull();
});
