import { describe, expect, it } from "vitest";

import type {
  RunLogEntry,
  RunProgressEvent
} from "../../../hooks/use-admin-skill-judge-data";
import {
  describeLogEntry,
  describeProgress,
  formatInterval,
  logTone
} from "./page.logic";

describe("formatInterval", () => {
  it("renders sub-minute durations as seconds", () => {
    expect(formatInterval(0)).toBe("0s");
    expect(formatInterval(1_000)).toBe("1s");
    expect(formatInterval(45_000)).toBe("45s");
  });

  it("renders sub-hour durations as minutes", () => {
    expect(formatInterval(60_000)).toBe("1 min");
    expect(formatInterval(5 * 60_000)).toBe("5 min");
    expect(formatInterval(45 * 60_000)).toBe("45 min");
  });

  it("renders hour-and-up durations as hours", () => {
    expect(formatInterval(60 * 60_000)).toBe("1h");
    expect(formatInterval(3 * 60 * 60_000)).toBe("3h");
    expect(formatInterval(24 * 60 * 60_000)).toBe("24h");
  });

  it("rounds within each bucket", () => {
    // 89s → 1 min (closer than 2 min)
    expect(formatInterval(89_000)).toBe("1 min");
    // 91s → 2 min
    expect(formatInterval(91_000)).toBe("2 min");
    // 89 min → 1h
    expect(formatInterval(89 * 60_000)).toBe("1h");
  });
});

describe("describeProgress", () => {
  it("renders tick_started with and without tenant", () => {
    expect(describeProgress({ kind: "tick_started" } as RunProgressEvent)).toBe(
      "Started run."
    );
    expect(
      describeProgress({ kind: "tick_started", tenantId: "abc" } as RunProgressEvent)
    ).toBe("Started run (tenant=abc).");
  });

  it("singularizes 'session' for eligible_found", () => {
    expect(
      describeProgress({ kind: "eligible_found", count: 1 } as RunProgressEvent)
    ).toBe("Found 1 eligible session.");
    expect(
      describeProgress({ kind: "eligible_found", count: 5 } as RunProgressEvent)
    ).toBe("Found 5 eligible sessions.");
  });

  it("renders session lifecycle events", () => {
    expect(
      describeProgress({
        kind: "session_claimed",
        sessionId: "s1",
        provider: "anthropic",
        model: "haiku",
        mode: "sync"
      } as RunProgressEvent)
    ).toBe("Claimed session s1 (anthropic/haiku, sync).");

    expect(
      describeProgress({
        kind: "session_completed",
        sessionId: "s1",
        skillsJudged: 3,
        invokedCount: 2
      } as RunProgressEvent)
    ).toBe("Done s1 — judged 3 skill(s), 2 invoked.");

    expect(
      describeProgress({
        kind: "session_failed",
        sessionId: "s1",
        error: "boom"
      } as RunProgressEvent)
    ).toBe("Failed s1: boom");

    expect(
      describeProgress({
        kind: "session_skipped_no_skills",
        sessionId: "s1"
      } as RunProgressEvent)
    ).toBe("Skipped s1 — no skills were available in that session.");
  });

  it("renders batch and tick events", () => {
    expect(
      describeProgress({
        kind: "batch_submitted",
        batchId: "b1",
        sessionCount: 12,
        provider: "anthropic",
        model: "haiku"
      } as RunProgressEvent)
    ).toBe("Submitted batch b1 (12 session(s)) to anthropic/haiku.");

    expect(
      describeProgress({
        kind: "submit_skipped_inflight_batches",
        pendingBatchCount: 2
      } as RunProgressEvent)
    ).toBe("Skipped submit pass — 2 batch(es) still pending from a prior run.");

    expect(
      describeProgress({
        kind: "tick_completed",
        durationMs: 4321
      } as RunProgressEvent)
    ).toBe("Run finished in 4.3s.");
  });
});

describe("logTone", () => {
  it("returns 'err' for error entries", () => {
    expect(
      logTone({ type: "error", message: "x", at: 0 } as RunLogEntry)
    ).toBe("err");
  });

  it("returns 'ok' for done entries", () => {
    expect(logTone({ type: "done", at: 0 } as RunLogEntry)).toBe("ok");
  });

  it("returns 'warn' for failure / skip-due-to-inflight progress events", () => {
    expect(
      logTone({
        type: "progress",
        at: 0,
        event: { kind: "session_failed", sessionId: "s1", error: "x" }
      } as RunLogEntry)
    ).toBe("warn");

    expect(
      logTone({
        type: "progress",
        at: 0,
        event: {
          kind: "submit_skipped_inflight_batches",
          pendingBatchCount: 1
        }
      } as RunLogEntry)
    ).toBe("warn");
  });

  it("returns 'ok' for session_completed and tick_completed", () => {
    expect(
      logTone({
        type: "progress",
        at: 0,
        event: {
          kind: "session_completed",
          sessionId: "s1",
          skillsJudged: 1,
          invokedCount: 0
        }
      } as RunLogEntry)
    ).toBe("ok");

    expect(
      logTone({
        type: "progress",
        at: 0,
        event: { kind: "tick_completed", durationMs: 100 }
      } as RunLogEntry)
    ).toBe("ok");
  });

  it("falls through to 'ok' for other progress events", () => {
    expect(
      logTone({
        type: "progress",
        at: 0,
        event: { kind: "tick_started" }
      } as RunLogEntry)
    ).toBe("ok");
  });
});

describe("describeLogEntry", () => {
  it("delegates to describeProgress for progress entries", () => {
    expect(
      describeLogEntry({
        type: "progress",
        at: 0,
        event: { kind: "tick_started" }
      } as RunLogEntry)
    ).toBe("Started run.");
  });

  it("formats error entries with the cross marker", () => {
    expect(
      describeLogEntry({ type: "error", at: 0, message: "boom" } as RunLogEntry)
    ).toBe("✗ boom");
  });

  it("formats done entries as the close marker", () => {
    expect(describeLogEntry({ type: "done", at: 0 } as RunLogEntry)).toBe(
      "✓ Stream closed."
    );
  });
});
