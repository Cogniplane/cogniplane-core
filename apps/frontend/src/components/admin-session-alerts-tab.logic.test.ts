import { describe, expect, test } from "vitest";

import type {
  AdminSessionDetailApproval,
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";

import {
  buildAlertItems,
  buildApprovalAlertItem,
  buildErrorAlertItem,
  buildPiiAlertItem,
  readPiiScanRunId
} from "./admin-session-alerts-tab.logic";

function makePiiRun(partial: Partial<AdminSessionDetailPiiRun> & { scanRunId: string }): AdminSessionDetailPiiRun {
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

function makeApproval(
  partial: Partial<AdminSessionDetailApproval> & { approvalId: string }
): AdminSessionDetailApproval {
  return {
    approvalId: partial.approvalId,
    title: partial.title ?? "approve me",
    status: partial.status ?? "pending",
    decision: partial.decision ?? null,
    kind: partial.kind ?? "tool",
    summary: partial.summary ?? "",
    requestMethod: partial.requestMethod ?? "",
    turnId: partial.turnId ?? "",
    itemId: partial.itemId ?? "",
    createdAt: partial.createdAt ?? "2026-05-09T12:00:00Z",
    resolvedAt: partial.resolvedAt ?? null,
    requestPayload: partial.requestPayload ?? null
  } as AdminSessionDetailApproval;
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

  test("returns null when shape doesn't match", () => {
    expect(readPiiScanRunId(null)).toBeNull();
    expect(readPiiScanRunId(undefined)).toBeNull();
    expect(readPiiScanRunId("string")).toBeNull();
    expect(readPiiScanRunId({})).toBeNull();
    expect(readPiiScanRunId({ pii: null })).toBeNull();
    expect(readPiiScanRunId({ pii: { scanRunId: 42 } })).toBeNull();
  });
});

describe("buildPiiAlertItem", () => {
  test("prefers messageIdByScanRunId match over subjectId", () => {
    const run = makePiiRun({ scanRunId: "scan-1", subjectType: "message", subjectId: "subj-1" });
    const map = new Map([["scan-1", "msg-via-scan"]]);
    const item = buildPiiAlertItem(run, map);
    expect(item.jumpToMessageId).toBe("msg-via-scan");
    expect(item.summary).toContain("on message msg-via-");
  });

  test("falls back to subjectId for message-type runs without map entry", () => {
    const run = makePiiRun({ scanRunId: "scan-1", subjectType: "message", subjectId: "subj-1" });
    const item = buildPiiAlertItem(run, new Map());
    expect(item.jumpToMessageId).toBe("subj-1");
  });

  test("artifact subjects render 'on artifact' label and no jump target", () => {
    const run = makePiiRun({ scanRunId: "scan-1", subjectType: "artifact", subjectId: "art-1" });
    const item = buildPiiAlertItem(run, new Map());
    expect(item.jumpToMessageId).toBeNull();
    expect(item.summary).toContain("on artifact art-1");
  });

  test("color follows status: blocked=red, transformed=blue, else gray", () => {
    expect(
      buildPiiAlertItem(makePiiRun({ scanRunId: "a", status: "blocked" }), new Map()).iconColor
    ).toBe("red");
    expect(
      buildPiiAlertItem(makePiiRun({ scanRunId: "b", status: "transformed" }), new Map()).iconColor
    ).toBe("blue");
    expect(
      buildPiiAlertItem(makePiiRun({ scanRunId: "c", status: "completed" }), new Map()).iconColor
    ).toBe("gray");
  });
});

describe("buildApprovalAlertItem", () => {
  test("color follows status: rejected=red, pending=blue, else gray", () => {
    expect(buildApprovalAlertItem(makeApproval({ approvalId: "a", status: "rejected" })).iconColor).toBe("red");
    expect(buildApprovalAlertItem(makeApproval({ approvalId: "b", status: "pending" })).iconColor).toBe("blue");
    expect(buildApprovalAlertItem(makeApproval({ approvalId: "c", status: "approved" })).iconColor).toBe("gray");
  });

  test("includes decision in summary when present", () => {
    const item = buildApprovalAlertItem(
      makeApproval({ approvalId: "a", status: "approved", decision: "approve", title: "task" })
    );
    expect(item.summary).toBe("Approval approved (approve) — task");
  });
});

describe("buildErrorAlertItem", () => {
  test("uses trimmed contentText (truncated) when present", () => {
    const long = "x".repeat(120);
    const item = buildErrorAlertItem(
      makeMessage({ messageId: "m1", role: "assistant", status: "failed", contentText: ` ${long} ` })
    );
    expect(item.summary).toContain("x".repeat(80));
    expect(item.summary).not.toContain("x".repeat(81));
  });

  test("falls back to status when contentText is empty", () => {
    const item = buildErrorAlertItem(
      makeMessage({ messageId: "m1", role: "user", status: "failed", contentText: "  " })
    );
    expect(item.summary).toContain("failed");
  });
});

describe("buildAlertItems", () => {
  test("merges and sorts by timestamp ascending", () => {
    const items = buildAlertItems({
      messages: [
        makeMessage({ messageId: "m1", status: "failed", createdAt: "2026-05-09T11:00:00Z" })
      ],
      approvals: [
        makeApproval({ approvalId: "a1", createdAt: "2026-05-09T10:00:00Z" })
      ],
      piiRuns: [
        makePiiRun({ scanRunId: "s1", createdAt: "2026-05-09T12:00:00Z" })
      ]
    });
    expect(items.map((i) => i.kind)).toEqual(["approval", "error", "pii"]);
  });

  test("only failed/error message statuses produce error items", () => {
    const items = buildAlertItems({
      messages: [
        makeMessage({ messageId: "m1", status: "completed" }),
        makeMessage({ messageId: "m2", status: "failed" }),
        makeMessage({ messageId: "m3", status: "error" })
      ],
      approvals: [],
      piiRuns: []
    });
    expect(items.length).toBe(2);
  });

  test("uses scan-run-id map to resolve message link for PII alerts", () => {
    const items = buildAlertItems({
      messages: [
        makeMessage({
          messageId: "msg-1",
          status: "completed",
          detailJson: { pii: { scanRunId: "scan-1" } }
        })
      ],
      approvals: [],
      piiRuns: [makePiiRun({ scanRunId: "scan-1", subjectType: "message", subjectId: "old-subj" })]
    });
    const piiItem = items.find((i) => i.kind === "pii")!;
    expect(piiItem.jumpToMessageId).toBe("msg-1");
  });
});
