import { describe, expect, test } from "vitest";

import type {
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";

import {
  chatReplayStatusClass,
  indexPiiRuns,
  piiRunsForMessage,
  readPiiScanRunId
} from "./admin-chat-replay.logic";

function makeRun(
  partial: Partial<AdminSessionDetailPiiRun> & { scanRunId: string }
): AdminSessionDetailPiiRun {
  return {
    scanRunId: partial.scanRunId,
    subjectType: partial.subjectType ?? "message",
    subjectId: partial.subjectId ?? "msg-1",
    status: partial.status ?? "blocked",
    mode: partial.mode ?? "block",
    providerType: partial.providerType ?? null,
    providerModel: partial.providerModel ?? null,
    actionTaken: partial.actionTaken ?? null,
    findings: partial.findings ?? [],
    summaryText: partial.summaryText ?? null,
    errorMessage: partial.errorMessage ?? null,
    createdAt: partial.createdAt ?? "2026-05-09T12:00:00Z",
    completedAt: partial.completedAt ?? null
  } as AdminSessionDetailPiiRun;
}

function makeMessage(
  partial: Partial<AdminSessionDetailMessage> & { messageId: string }
): AdminSessionDetailMessage {
  return {
    messageId: partial.messageId,
    role: partial.role ?? "assistant",
    status: partial.status ?? "completed",
    contentText: partial.contentText ?? "",
    detailJson: partial.detailJson ?? null,
    createdAt: partial.createdAt ?? "2026-05-09T12:00:00Z"
  } as AdminSessionDetailMessage;
}

describe("readPiiScanRunId", () => {
  test("reads detailJson.pii.scanRunId when present", () => {
    expect(readPiiScanRunId({ pii: { scanRunId: "scan-1" } })).toBe("scan-1");
  });

  test("returns null on missing/wrong shape", () => {
    expect(readPiiScanRunId(null)).toBeNull();
    expect(readPiiScanRunId({})).toBeNull();
    expect(readPiiScanRunId({ pii: { scanRunId: 42 } })).toBeNull();
  });
});

describe("indexPiiRuns", () => {
  test("indexes by scan id and by message-subject id", () => {
    const runs = [
      makeRun({ scanRunId: "s1", subjectType: "message", subjectId: "msg-1" }),
      makeRun({ scanRunId: "s2", subjectType: "artifact", subjectId: "art-1" }),
      makeRun({ scanRunId: "s3", subjectType: "message", subjectId: "msg-1" })
    ];
    const idx = indexPiiRuns(runs);
    expect(idx.byScanId.size).toBe(3);
    expect(idx.byMessageId.get("msg-1")?.length).toBe(2);
    // Artifacts are not indexed by-message — their subjectId is an artifact id.
    expect(idx.byMessageId.has("art-1")).toBe(false);
  });
});

describe("piiRunsForMessage", () => {
  test("returns direct matches when no detailJson link", () => {
    const runs = [makeRun({ scanRunId: "s1", subjectType: "message", subjectId: "msg-1" })];
    const idx = indexPiiRuns(runs);
    const out = piiRunsForMessage(idx, makeMessage({ messageId: "msg-1" }));
    expect(out.map((r) => r.scanRunId)).toEqual(["s1"]);
  });

  test("appends scanRunId-linked run when not already in direct matches", () => {
    const runs = [
      makeRun({ scanRunId: "s-direct", subjectType: "message", subjectId: "msg-1" }),
      makeRun({ scanRunId: "s-linked", subjectType: "message", subjectId: "session-1" })
    ];
    const idx = indexPiiRuns(runs);
    const message = makeMessage({
      messageId: "msg-1",
      detailJson: { pii: { scanRunId: "s-linked" } }
    });
    const out = piiRunsForMessage(idx, message);
    expect(out.map((r) => r.scanRunId).sort()).toEqual(["s-direct", "s-linked"]);
  });

  test("does not duplicate when linked run is already in direct matches", () => {
    const runs = [makeRun({ scanRunId: "s1", subjectType: "message", subjectId: "msg-1" })];
    const idx = indexPiiRuns(runs);
    const message = makeMessage({
      messageId: "msg-1",
      detailJson: { pii: { scanRunId: "s1" } }
    });
    const out = piiRunsForMessage(idx, message);
    expect(out).toHaveLength(1);
  });
});

describe("chatReplayStatusClass", () => {
  test("maps known statuses literally", () => {
    expect(chatReplayStatusClass("pending")).toBe("pending");
    expect(chatReplayStatusClass("streaming")).toBe("streaming");
    expect(chatReplayStatusClass("completed")).toBe("completed");
    expect(chatReplayStatusClass("error")).toBe("error");
  });

  test("maps 'failed' to 'error' for legacy shapes", () => {
    expect(chatReplayStatusClass("failed")).toBe("error");
  });

  test("falls back to 'completed' for unknown values", () => {
    expect(chatReplayStatusClass("anything-else")).toBe("completed");
  });
});
