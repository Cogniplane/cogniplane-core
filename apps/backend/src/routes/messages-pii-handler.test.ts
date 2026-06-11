import { test, expect } from "vitest";

import type { PiiDecision } from "../services/pii/pii-protection-service.js";

import { handlePiiDecision } from "./messages-pii-handler.js";

const baseInput = {
  tenantId: "t",
  sessionId: "s",
  userId: "u",
  rawText: "raw"
};

function makeStores(opts: { capture?: unknown[]; throwOnCreate?: boolean } = {}) {
  const capture = opts.capture ?? [];
  return {
    piiScanRuns: {
      async create(input: Record<string, unknown>) {
        if (opts.throwOnCreate) throw new Error("scan-run create failed");
        capture.push(input);
        return { scanRunId: `run-${capture.length}` } as never;
      }
    }
  };
}

test("returns continue with raw text when decision is null", async () => {
  const out = await handlePiiDecision(null, baseInput, { piiScanRuns: undefined });
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    expect(out.persistedText).toBe("raw");
    expect(out.runtimePrompt).toBe("raw");
    expect(out.userDetail).toBe(undefined);
  }
});

test("returns continue with raw text when decision.action === 'allow'", async () => {
  const allow: PiiDecision = {
    action: "allow",
    providerType: "rule_based",
    providerModel: null,
    findings: []
  };
  const out = await handlePiiDecision(allow, baseInput, { piiScanRuns: undefined });
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    expect(out.persistedText).toBe("raw");
    expect(out.userDetail).toBe(undefined);
  }
});

test("block action persists scan run and surfaces blockReason", async () => {
  const captured: unknown[] = [];
  const stores = makeStores({ capture: captured });
  const decision: PiiDecision = {
    action: "block",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: [{ piiType: "email", confidence: "high" } as never],
    blockReason: "blocked_email"
  };
  const out = await handlePiiDecision(decision, baseInput, stores);
  expect(out.kind).toBe("block");
  if (out.kind === "block") {
    expect(out.blockReason).toBe("blocked_email");
    expect(String(out.scanRunId)).toMatch(/^run-\d+$/);
  }
  expect(captured.length).toBe(1);
  const persisted = captured[0] as Record<string, unknown>;
  expect(persisted.mode).toBe("block");
  expect(persisted.status).toBe("blocked");
  expect(persisted.actionTaken).toBe("block");
});

test("block action returns scanRunId=null when piiScanRuns store missing", async () => {
  const decision: PiiDecision = {
    action: "block",
    providerType: "rule_based",
    providerModel: null,
    findings: [],
    blockReason: "boom"
  };
  const out = await handlePiiDecision(decision, baseInput, { piiScanRuns: undefined });
  expect(out.kind).toBe("block");
  if (out.kind === "block") {
    expect(out.scanRunId).toBe(null);
    expect(out.blockReason).toBe("boom");
  }
});

test("transform action substitutes runtime prompt and persists scanRun", async () => {
  const captured: unknown[] = [];
  const stores = makeStores({ capture: captured });
  const decision: PiiDecision = {
    action: "transform",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: [{ piiType: "phone", confidence: "high" } as never],
    transformedText: "raw with [REDACTED]"
  };
  const out = await handlePiiDecision(decision, baseInput, stores);
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    expect(out.persistedText).toBe("raw with [REDACTED]");
    expect(out.runtimePrompt).toBe("raw with [REDACTED]");
    expect(out.transformScanRunId).toBe("run-1");
    expect(out.userDetail).toEqual({
            pii: {
              status: "transformed",
              modeApplied: "transform",
              transformed: true,
              scanRunId: "run-1",
              findingsCount: 1
            }
          });
  }
  expect(captured.length).toBe(1);
  const meta = captured[0] as Record<string, unknown>;
  expect(meta.mode).toBe("transform");
});

test("transform action: when scan-run store missing, userDetail omits scanRunId", async () => {
  const decision: PiiDecision = {
    action: "transform",
    providerType: "rule_based",
    providerModel: null,
    findings: [],
    transformedText: "X"
  };
  const out = await handlePiiDecision(decision, baseInput, { piiScanRuns: undefined });
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    expect(out.transformScanRunId).toBe(undefined);
    const detail = out.userDetail!.pii as Record<string, unknown>;
    expect(detail.scanRunId).toBe(undefined);
    expect(detail.findingsCount).toBe(0);
    expect(detail.transformed).toBe(true);
  }
});

test("report action keeps raw text but emits a 'detected' detail block", async () => {
  const captured: unknown[] = [];
  const stores = makeStores({ capture: captured });
  const decision: PiiDecision = {
    action: "report",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: [
      { piiType: "ssn", confidence: "high" } as never,
      { piiType: "ssn", confidence: "low" } as never
    ]
  };
  const out = await handlePiiDecision(decision, baseInput, stores);
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    expect(out.persistedText).toBe("raw");
    expect(out.runtimePrompt).toBe("raw");
    expect(out.transformScanRunId).toBe(undefined);
    expect(out.userDetail).toEqual({
            pii: {
              status: "detected",
              modeApplied: "detect",
              scanRunId: "run-1",
              findingsCount: 2
            }
          });
  }
  expect((captured[0] as Record<string, unknown>).mode).toBe("detect");
  expect((captured[0] as Record<string, unknown>).actionTaken).toBe("report");
});

test("report action: when scan-run store missing, no scanRunId in detail", async () => {
  const decision: PiiDecision = {
    action: "report",
    providerType: "rule_based",
    providerModel: null,
    findings: []
  };
  const out = await handlePiiDecision(decision, baseInput, { piiScanRuns: undefined });
  expect(out.kind).toBe("continue");
  if (out.kind === "continue") {
    const detail = out.userDetail!.pii as Record<string, unknown>;
    expect(detail.status).toBe("detected");
    expect(detail.scanRunId).toBe(undefined);
    expect(detail.findingsCount).toBe(0);
  }
});

function makeAuditCapture() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    auditEvents: {
      async create(input: Record<string, unknown>) {
        events.push(input);
      }
    }
  };
}

test("block action emits pii_blocked audit event with scanRunId + blockReason", async () => {
  const captured: unknown[] = [];
  const audit = makeAuditCapture();
  const decision: PiiDecision = {
    action: "block",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: [{ piiType: "email", confidence: "high" } as never],
    blockReason: "blocked_email"
  };
  await handlePiiDecision(decision, baseInput, {
    ...makeStores({ capture: captured }),
    auditEvents: audit.auditEvents
  });
  expect(audit.events.length).toBe(1);
  const event = audit.events[0];
  expect(event.type).toBe("pii_blocked");
  expect(event.tenantId).toBe("t");
  expect(event.userId).toBe("u");
  const payload = event.payload as Record<string, unknown>;
  expect(payload.mode).toBe("block");
  expect(payload.subjectType).toBe("message");
  expect(payload.blockReason).toBe("blocked_email");
  expect(payload.findingsCount).toBe(1);
  expect(String(payload.scanRunId)).toMatch(/^run-\d+$/);
});

test("transform action emits pii_transformed audit event", async () => {
  const audit = makeAuditCapture();
  const decision: PiiDecision = {
    action: "transform",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: [{ piiType: "phone", confidence: "high" } as never],
    transformedText: "X"
  };
  await handlePiiDecision(decision, baseInput, {
    ...makeStores({ capture: [] }),
    auditEvents: audit.auditEvents
  });
  expect(audit.events.length).toBe(1);
  expect(audit.events[0].type).toBe("pii_transformed");
});

test("report action emits pii_reported audit event", async () => {
  const audit = makeAuditCapture();
  const decision: PiiDecision = {
    action: "report",
    providerType: "openai-compatible",
    providerModel: "google/gemini",
    findings: []
  };
  await handlePiiDecision(decision, baseInput, {
    ...makeStores({ capture: [] }),
    auditEvents: audit.auditEvents
  });
  expect(audit.events.length).toBe(1);
  expect(audit.events[0].type).toBe("pii_reported");
});

test("allow action does NOT emit an audit event", async () => {
  const audit = makeAuditCapture();
  const allow: PiiDecision = {
    action: "allow",
    providerType: "rule_based",
    providerModel: null,
    findings: []
  };
  await handlePiiDecision(allow, baseInput, {
    piiScanRuns: undefined,
    auditEvents: audit.auditEvents
  });
  expect(audit.events.length).toBe(0);
});

test("non-allow action with no auditEvents store does not throw", async () => {
  const decision: PiiDecision = {
    action: "block",
    providerType: "openai-compatible",
    providerModel: "m",
    findings: [],
    blockReason: "x"
  };
  await handlePiiDecision(decision, baseInput, makeStores({ capture: [] }));
  // No assertion needed — just verifying no crash when auditEvents is omitted.
});
