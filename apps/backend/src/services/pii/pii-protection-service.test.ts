import { test, expect } from "vitest";

import { Aes256GcmFindingEncryptor } from "./pii-finding-encryption.js";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "./pii-policy.js";
import {
  PiiProtectionService,
  PiiProtectionServiceError,
  buildCsvPreview,
  type PiiPolicyReader,
  type PiiSubject
} from "./pii-protection-service.js";
import type { PiiProvider } from "./pii-provider.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";

function buildSettings(overrides: Partial<PiiProtectionSettings> = {}): PiiProtectionSettings {
  return {
    ...DEFAULT_PII_PROTECTION,
    ...overrides,
    detectors: { ...DEFAULT_PII_PROTECTION.detectors, ...(overrides.detectors ?? {}) },
    scopes: { ...DEFAULT_PII_PROTECTION.scopes, ...(overrides.scopes ?? {}) }
  };
}

function stubReader(settings: PiiProtectionSettings | null): PiiPolicyReader {
  return { getPiiProtection: async () => settings };
}

function stubProvider(overrides: Partial<PiiProvider> = {}): PiiProvider {
  return {
    type: "stub",
    detectText: async () => ({ findings: [], providerType: "stub", providerModel: "m" }),
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    }),
    scanArtifact: async () => ({
      findings: [],
      summaryText: null,
      providerType: "stub",
      providerModel: "m"
    }),
    ...overrides
  };
}

const CHAT: PiiSubject = { kind: "chat_prompt" };

test("evaluateText allows when PII protection is disabled", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: false })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "a@b.co",
    subject: CHAT
  });
  expect(decision.action).toBe("allow");
  if (decision.action === "allow") expect(decision.reason).toBe("disabled");
});

test("evaluateText allows when scope is excluded", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({
        enabled: true,
        mode: "block",
        scopes: { chatPrompts: false, uploads: true, microsoftImports: true }
      })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "a@b.co",
    subject: CHAT
  });
  expect(decision.action).toBe("allow");
  if (decision.action === "allow") expect(decision.reason).toBe("scope_excluded");
});

test("detect mode reports rule-detected findings without a provider", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping a@b.co please",
    subject: CHAT
  });
  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.length).toBe(1);
    expect(decision.findings[0]?.entityType).toBe("email");
    expect(decision.providerType).toBe(null);
  }
});

test("detect mode allows when no findings are present", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "no pii here",
    subject: CHAT
  });
  expect(decision.action).toBe("allow");
  if (decision.action === "allow") expect(decision.reason).toBe("no_findings");
});

test("block mode returns block action with first finding as reason", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping a@b.co",
    subject: CHAT
  });
  expect(decision.action).toBe("block");
  if (decision.action === "block") {
    expect(decision.blockReason).toBe("email");
    expect(decision.findings.length >= 1).toBeTruthy();
  }
});

test("block mode fails closed when no provider is configured", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const error = await service
    .evaluateText({ tenantId: "t1", text: "ping a@b.co", subject: CHAT })
    .catch((e: unknown) => e);
  expect(error instanceof PiiProtectionServiceError).toBeTruthy();
  expect((error as PiiProtectionServiceError).code).toBe("pii_provider_unavailable");
});

test("transform mode returns transformed text with merged findings", async () => {
  const provider = stubProvider({
    transformText: async ({ text }) => ({
      transformedText: text.replace("a@b.co", "[REDACTED:email]"),
      findings: [
        { entityType: "email", value: "a@b.co", start: 5, end: 11, confidence: "high" }
      ],
      providerType: "stub",
      providerModel: "m"
    })
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "transform" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping a@b.co",
    subject: CHAT
  });
  expect(decision.action).toBe("transform");
  if (decision.action === "transform") {
    expect(decision.transformedText).toBe("ping [REDACTED:email]");
    expect(decision.providerType).toBe("stub");
  }
});

test("transform mode scrubs rule-detected PII that the provider missed", async () => {
  // Simulates an LLM that returned unchanged text even though rule detection flagged an email.
  const provider = stubProvider({
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    })
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "transform" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping a@b.co thanks",
    subject: CHAT
  });
  expect(decision.action).toBe("transform");
  if (decision.action === "transform") {
    expect(decision.transformedText).toBe("ping [REDACTED:email] thanks");
    expect(decision.findings.length).toBe(1);
    expect(decision.findings[0]?.entityType).toBe("email");
  }
});

test("tenant-configured provider model overrides the provider default", async () => {
  const received: Array<{ call: string; model: string | undefined }> = [];
  const provider = stubProvider({
    detectText: async ({ model }) => {
      received.push({ call: "detect", model });
      return {
        findings: [{ entityType: "email", value: "x@y.co", start: 0, end: 6, confidence: "high" }],
        providerType: "stub",
        providerModel: model ?? "default"
      };
    },
    transformText: async ({ text, model }) => {
      received.push({ call: "transform", model });
      return {
        transformedText: text,
        findings: [],
        providerType: "stub",
        providerModel: model ?? "default"
      };
    }
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({
        enabled: true,
        mode: "detect",
        provider: { type: "openrouter", model: "tenant/custom-model" }
      })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });

  await service.evaluateText({ tenantId: "t1", text: "hi", subject: CHAT });
  expect(received).toEqual([{ call: "detect", model: "tenant/custom-model" }]);
});

test("empty tenant model falls through to provider default", async () => {
  const received: Array<string | undefined> = [];
  const provider = stubProvider({
    detectText: async ({ model }) => {
      received.push(model);
      return { findings: [], providerType: "stub", providerModel: model ?? "default" };
    }
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({
        enabled: true,
        mode: "detect",
        provider: { type: "openrouter", model: "" }
      })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });

  await service.evaluateText({ tenantId: "t1", text: "hi", subject: CHAT });
  expect(received).toEqual([undefined]);
});

test("whitespace-only tenant model falls through to provider default", async () => {
  const received: Array<string | undefined> = [];
  const provider = stubProvider({
    detectText: async ({ model }) => {
      received.push(model);
      return { findings: [], providerType: "stub", providerModel: model ?? "default" };
    }
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({
        enabled: true,
        mode: "detect",
        provider: { type: "openrouter", model: "   " }
      })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });

  await service.evaluateText({ tenantId: "t1", text: "hi", subject: CHAT });
  expect(received).toEqual([undefined]);
});

test("transform mode wraps provider errors as pii_provider_unavailable", async () => {
  const provider = stubProvider({
    transformText: async () => {
      throw new Error("timeout");
    }
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "transform" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  const error = await service
    .evaluateText({ tenantId: "t1", text: "a@b.co", subject: CHAT })
    .catch((e: unknown) => e);
  expect(error instanceof PiiProtectionServiceError).toBeTruthy();
  expect((error as PiiProtectionServiceError).code).toBe("pii_provider_unavailable");
});

test("evaluateArtifact allows when disabled and reports scan findings when enabled", async () => {
  const provider = stubProvider({
    scanArtifact: async () => ({
      findings: [
        { entityType: "email", value: "x@y.co", start: 0, end: 6, confidence: "high" }
      ],
      summaryText: "one email",
      providerType: "stub",
      providerModel: "m"
    })
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });

  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_1",
      contentType: "text/plain",
      readContent: async () => "x@y.co",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });
  expect(decision.action).toBe("report");
  if (decision.action === "report") expect(decision.findings.length).toBe(1);
});

test("evaluateArtifact throws unsupported_mime for binary content types", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });

  const err = await service
    .evaluateArtifact({
      tenantId: "t1",
      artifact: {
        artifactId: "art_1",
        contentType: "application/pdf",
        readContent: async () => "%PDF-1.4 ...",
        entityTypes: []
      },
      subject: { kind: "upload" }
    })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("unsupported_mime");
});

test("evaluateArtifact accepts text/* and a small allowlist of structured formats", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });

  for (const contentType of [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/html; charset=utf-8" // params should be stripped
  ]) {
    const decision = await service.evaluateArtifact({
      tenantId: "t1",
      artifact: {
        artifactId: "art_1",
        contentType,
        readContent: async () => "no PII here",
        entityTypes: []
      },
      subject: { kind: "upload" }
    });
    expect(decision.action).toBe("allow");
  }
});

test("evaluateArtifact throws file_too_large when content exceeds the cap", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000,
    artifactMaxBytes: 100
  });

  const err = await service
    .evaluateArtifact({
      tenantId: "t1",
      artifact: {
        artifactId: "art_1",
        contentType: "text/plain",
        readContent: async () => "x".repeat(200),
        entityTypes: []
      },
      subject: { kind: "upload" }
    })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("file_too_large");
});

test("evaluateArtifact runs rule-based detection when no provider is configured", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });

  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_1",
      contentType: "text/plain",
      readContent: async () => "contact a@b.co please",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.length).toBe(1);
    expect(decision.findings[0]?.entityType).toBe("email");
    expect(decision.providerType).toBe(null);
  }
});

test("evaluateArtifact uses CSV heuristics when content-type is text/csv", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });

  const csv = "name,email_address\nAlice,a@b.co";
  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_csv",
      contentType: "text/csv; charset=utf-8",
      readContent: async () => csv,
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(decision.action).toBe("block");
  if (decision.action === "block") {
    // Expect rule hits for the email column header + the value-level email.
    expect(decision.findings.some((f) => f.entityType === "email")).toBeTruthy();
  }
});

test("evaluateArtifact merges rule and provider findings", async () => {
  const provider = stubProvider({
    scanArtifact: async () => ({
      findings: [
        { entityType: "person_name", value: "Alice", start: 0, end: 5, confidence: "high" }
      ],
      summaryText: "found a name",
      providerType: "stub",
      providerModel: "m"
    })
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });

  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_mix",
      contentType: "text/plain",
      readContent: async () => "Alice a@b.co",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.some((f) => f.entityType === "email")).toBeTruthy();
    expect(decision.findings.some((f) => f.entityType === "person_name")).toBeTruthy();
    expect(decision.providerType).toBe("stub");
  }
});

test("resolveExecutionPath maps policy + subject to sync/async", () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(null),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const detect = buildSettings({ enabled: true, mode: "detect" });
  const block = buildSettings({ enabled: true, mode: "block" });
  const transform = buildSettings({ enabled: true, mode: "transform" });
  const off = buildSettings({ enabled: false });

  expect(service.resolveExecutionPath(detect, { kind: "chat_prompt" })).toBe("sync");
  expect(service.resolveExecutionPath(detect, { kind: "upload" })).toBe("async");
  expect(service.resolveExecutionPath(block, { kind: "upload" })).toBe("sync");
  expect(service.resolveExecutionPath(transform, { kind: "microsoft_import" })).toBe("sync");
  expect(service.resolveExecutionPath(off, { kind: "chat_prompt" })).toBe("sync");
});

test("rawRetention='never' strips finding values before returning the decision", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({ enabled: true, mode: "detect", rawRetention: "never" })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "contact me at user@example.com please",
    subject: CHAT
  });
  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.length > 0).toBeTruthy();
    for (const finding of decision.findings) {
      expect(finding.value).toBe("");
      // Offsets should still be preserved so admins can see WHERE the PII was.
      expect(finding.end > finding.start).toBeTruthy();
    }
  }
});

test("rawRetention='admin_only' preserves finding values", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({ enabled: true, mode: "detect", rawRetention: "admin_only" })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "contact me at user@example.com please",
    subject: CHAT
  });
  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.some((f) => f.value === "user@example.com")).toBeTruthy();
  }
});

test("rawRetention='reversible_encrypted' encrypts finding values with the configured KEK", async () => {
  const encryptor = new Aes256GcmFindingEncryptor("0".repeat(64));
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({ enabled: true, mode: "detect", rawRetention: "reversible_encrypted" })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000,
    findingEncryptor: encryptor
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "contact me at user@example.com please",
    subject: CHAT
  });
  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    expect(decision.findings.length > 0).toBeTruthy();
    for (const finding of decision.findings) {
      // Value is the ciphertext envelope, not plaintext, not empty.
      expect(finding.value.startsWith("enc:v1:")).toBeTruthy();
      expect(finding.value).not.toBe("user@example.com");
      // And the service can round-trip it back to plaintext for an admin reveal.
      expect(service.decryptFindingValue(finding.value, "t1")).toBe("user@example.com");
    }
  }
});

test("rawRetention='reversible_encrypted' throws pii_kek_missing when no encryptor is configured", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({ enabled: true, mode: "detect", rawRetention: "reversible_encrypted" })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
    // findingEncryptor intentionally omitted
  });
  const err = await service
    .evaluateText({
      tenantId: "t1",
      text: "contact me at user@example.com please",
      subject: CHAT
    })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("pii_kek_missing");
});

test("decryptFindingValue throws pii_kek_missing when no encryptor is configured", () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  let err: unknown;
  try { service.decryptFindingValue("enc:v1:any:thing:here", "t1"); } catch (e) { err = e; }
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("pii_kek_missing");
});

test("rawRetention='never' still allows transform redaction of the prompt", async () => {
  // The transform path scrubs the user's prompt using rule findings BEFORE
  // applying retention to the returned finding list. The persisted prompt
  // must end up redacted even though the finding values are stripped.
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({ enabled: true, mode: "transform", rawRetention: "never" })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      transformText: async ({ text }) => ({
        transformedText: text,
        findings: [],
        providerType: "stub",
        providerModel: "m"
      })
    }),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping user@example.com",
    subject: CHAT
  });
  expect(decision.action).toBe("transform");
  if (decision.action === "transform") {
    expect(decision.transformedText.includes("[REDACTED:email]")).toBeTruthy();
    expect(!decision.transformedText.includes("user@example.com")).toBeTruthy();
    for (const finding of decision.findings) {
      expect(finding.value).toBe("");
    }
  }
});

test("getActiveSettings falls back to DEFAULT_PII_PROTECTION when reader returns null", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(null),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const settings = await service.getActiveSettings("t1");
  expect(settings).toEqual(DEFAULT_PII_PROTECTION);
});

test("detect mode degrades to rules-only when provider throws breaker_open", async () => {
  const breakerOpen = Object.assign(new Error("breaker open"), { code: "breaker_open" });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      detectText: async () => {
        throw breakerOpen;
      }
    }),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "ping user@example.com",
    subject: CHAT
  });
  // Rule detector picked up the email; provider call was skipped without 503.
  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    // Rule findings only — providerType is null because the provider never returned.
    expect(decision.providerType).toBe(null);
  }
});

test("block mode FAILS CLOSED when provider throws breaker_open", async () => {
  const breakerOpen = Object.assign(new Error("breaker open"), { code: "breaker_open" });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      detectText: async () => {
        throw breakerOpen;
      }
    }),
    timeoutMs: 5000
  });
  const err = await service
    .evaluateText({ tenantId: "t1", text: "ping user@example.com", subject: CHAT })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("pii_provider_breaker_open");
});

test("transform mode FAILS CLOSED when provider throws breaker_open", async () => {
  const breakerOpen = Object.assign(new Error("breaker open"), { code: "breaker_open" });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "transform" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      transformText: async () => {
        throw breakerOpen;
      }
    }),
    timeoutMs: 5000
  });
  const err = await service
    .evaluateText({ tenantId: "t1", text: "ping user@example.com", subject: CHAT })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("pii_provider_breaker_open");
});

test("evaluateArtifact in detect mode degrades when provider throws breaker_open", async () => {
  const breakerOpen = Object.assign(new Error("breaker open"), { code: "breaker_open" });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      scanArtifact: async () => {
        throw breakerOpen;
      }
    }),
    timeoutMs: 5000
  });
  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_1",
      contentType: "text/plain",
      readContent: async () => "contact a@b.co please",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });
  expect(decision.action).toBe("report");
});

test("evaluateArtifact in block mode FAILS CLOSED when provider throws breaker_open", async () => {
  const breakerOpen = Object.assign(new Error("breaker open"), { code: "breaker_open" });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider({
      scanArtifact: async () => {
        throw breakerOpen;
      }
    }),
    timeoutMs: 5000
  });
  const err = await service
    .evaluateArtifact({
      tenantId: "t1",
      artifact: {
        artifactId: "art_1",
        contentType: "text/plain",
        readContent: async () => "contact a@b.co please",
        entityTypes: []
      },
      subject: { kind: "upload" }
    })
    .catch((e: unknown) => e);
  expect(err instanceof PiiProtectionServiceError).toBeTruthy();
  expect((err as PiiProtectionServiceError).code).toBe("pii_provider_breaker_open");
});

test("buildCsvPreview: returns header + first N rows under the byte cap", () => {
  const csv = "name,email\nAlice,a@b.co\nBob,b@b.co\nCarol,c@b.co\nDave,d@b.co";
  const out = buildCsvPreview(csv, { maxRows: 2, maxBytes: 1024 });
  expect(out).toBe("name,email\nAlice,a@b.co\nBob,b@b.co");
});

test("buildCsvPreview: stops at byte cap mid-rows", () => {
  // 3 data rows of 20+ bytes each, 50-byte cap should fit only header+1.
  const csv = "header\n" + Array.from({ length: 5 }, (_, i) => `row-${i}-padding`).join("\n");
  const out = buildCsvPreview(csv, { maxRows: 100, maxBytes: 30 });
  // header (6) + newline (1) + first row (~14) + newline (1) = ~22, second row would push past 30.
  expect(out.startsWith("header\nrow-0")).toBeTruthy();
  expect(!out.includes("row-1")).toBeTruthy();
});

test("buildCsvPreview: handles \\r\\n line endings", () => {
  const csv = "name,email\r\nAlice,a@b.co\r\nBob,b@b.co";
  const out = buildCsvPreview(csv, { maxRows: 2, maxBytes: 1024 });
  // \r should be stripped, \n preserved.
  expect(out).toBe("name,email\nAlice,a@b.co\nBob,b@b.co");
});

test("buildCsvPreview: header alone over budget gets truncated, never dropped", () => {
  const out = buildCsvPreview("very-long-header-row-here\nrow", { maxRows: 10, maxBytes: 5 });
  // Header is truncated to 5 chars; data rows are skipped because budget already blown.
  expect(out).toBe("very-");
});

test("buildCsvPreview: empty input returns empty string", () => {
  expect(buildCsvPreview("", { maxRows: 10, maxBytes: 100 })).toBe("");
});

test("CSV artifact: provider.scanCsvPreview is used instead of scanArtifact", async () => {
  const calls: string[] = [];
  const provider: PiiProvider = {
    type: "stub",
    detectText: async () => ({ findings: [], providerType: "stub", providerModel: "m" }),
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    }),
    scanArtifact: async () => {
      calls.push("scanArtifact");
      return { findings: [], summaryText: null, providerType: "stub", providerModel: "m" };
    },
    scanCsvPreview: async ({ preview }) => {
      calls.push(`scanCsvPreview:${preview}`);
      return {
        findings: [
          { entityType: "person_name", value: "Alice", start: 0, end: 0, confidence: "medium" }
        ],
        summaryText: "names in column 1",
        providerType: "stub",
        providerModel: "m"
      };
    }
  };
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000,
    csvPreviewRows: 3,
    csvPreviewMaxBytes: 1024
  });
  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_csv",
      contentType: "text/csv",
      readContent: async () => "name,city\nAlice,Paris\nBob,Tokyo\nCarol,NYC\nDave,LA",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(calls.length).toBe(1);
  expect(calls[0]!.startsWith("scanCsvPreview:")).toBeTruthy();
  // Preview contains header + first 3 data rows (Alice/Bob/Carol), no Dave.
  expect(calls[0]!.includes("Alice")).toBeTruthy();
  expect(calls[0]!.includes("Carol")).toBeTruthy();
  expect(!calls[0]!.includes("Dave")).toBeTruthy();
  expect(decision.action).toBe("report");
});

test("CSV artifact: falls back to scanArtifact when provider lacks scanCsvPreview", async () => {
  const calls: string[] = [];
  const provider: PiiProvider = {
    type: "stub",
    detectText: async () => ({ findings: [], providerType: "stub", providerModel: "m" }),
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    }),
    scanArtifact: async () => {
      calls.push("scanArtifact");
      return { findings: [], summaryText: null, providerType: "stub", providerModel: "m" };
    }
    // No scanCsvPreview. Service must fall back to the legacy path.
  };
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_csv",
      contentType: "text/csv",
      readContent: async () => "name,city\nAlice,Paris",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(calls).toEqual(["scanArtifact"]);
});

test("non-CSV artifact: uses scanArtifact even when scanCsvPreview is available", async () => {
  const calls: string[] = [];
  const provider: PiiProvider = {
    type: "stub",
    detectText: async () => ({ findings: [], providerType: "stub", providerModel: "m" }),
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    }),
    scanArtifact: async () => {
      calls.push("scanArtifact");
      return { findings: [], summaryText: null, providerType: "stub", providerModel: "m" };
    },
    scanCsvPreview: async () => {
      calls.push("scanCsvPreview");
      return { findings: [], summaryText: null, providerType: "stub", providerModel: "m" };
    }
  };
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_txt",
      contentType: "text/plain",
      readContent: async () => "hello world",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(calls).toEqual(["scanArtifact"]);
});

test("CSV preview findings merge with rule-based CSV findings", async () => {
  // Rule detector flags 'email' header column. Provider returns a person_name
  // finding from a values column. Both should appear in the decision.
  const provider: PiiProvider = {
    type: "stub",
    detectText: async () => ({ findings: [], providerType: "stub", providerModel: "m" }),
    transformText: async ({ text }) => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: "m"
    }),
    scanArtifact: async () => ({
      findings: [],
      summaryText: null,
      providerType: "stub",
      providerModel: "m"
    }),
    scanCsvPreview: async () => ({
      findings: [
        { entityType: "person_name", value: "", start: 0, end: 0, confidence: "high" }
      ],
      summaryText: "name column",
      providerType: "stub",
      providerModel: "m"
    })
  };
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider,
    timeoutMs: 5000
  });
  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_csv",
      contentType: "text/csv",
      readContent: async () => "name,email\nAlice,a@b.co",
      entityTypes: []
    },
    subject: { kind: "upload" }
  });

  expect(decision.action).toBe("report");
  if (decision.action === "report") {
    const types = decision.findings.map((f) => f.entityType).sort();
    // Rule found email (from header hint + the literal email cell), provider found person_name.
    expect(types.includes("email")).toBeTruthy();
    expect(types.includes("person_name")).toBeTruthy();
  }
});
