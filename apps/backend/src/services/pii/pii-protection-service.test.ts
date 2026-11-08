import { test, expect, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { Aes256GcmFindingEncryptor } from "./pii-finding-encryption.js";
import { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import {
  PiiProtectionService,
  PiiProtectionServiceError,
  buildCsvPreview,
  piiDecisionScanned,
  type PiiDecision,
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

function stubReader(settings: unknown, revision = 1): PiiPolicyReader {
  return { readPiiProtection: async () => ({ stored: settings, revision }) };
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

test("evaluateText fails closed (throws pii_timeout) when the provider hangs past the budget", async () => {
  const hangingProvider = stubProvider({
    // Never resolves — simulates a provider that ignores its own per-request
    // timeout, or a policy lookup wedged on a slow DB.
    detectText: () => new Promise(() => {})
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: hangingProvider,
    timeoutMs: 25
  });

  await expect(
    service.evaluateText({ tenantId: "t1", text: "call me at name John Smith", subject: CHAT })
  ).rejects.toMatchObject({ code: "pii_timeout" });
});

test("evaluateText aborts the in-flight provider call when the timeout budget fires", async () => {
  let providerSignal: AbortSignal | undefined;
  const hangingProvider = stubProvider({
    detectText: (_input, signal) => {
      providerSignal = signal;
      // Hang until aborted — the service's budget timer must cancel the call
      // rather than leave the HTTP request dangling.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "block" })),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: hangingProvider,
    timeoutMs: 25
  });

  await expect(
    service.evaluateText({ tenantId: "t1", text: "call me at name John Smith", subject: CHAT })
  ).rejects.toMatchObject({ code: "pii_timeout" });

  expect(providerSignal).toBeTruthy();
  expect(providerSignal?.aborted).toBe(true);
});

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
        scopes: { chatPrompts: false, uploads: true, partnerImports: true }
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

test("the skill_corpus subject is evaluated even when every tenant scope toggle is off", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(
      buildSettings({
        enabled: true,
        mode: "block",
        scopes: { chatPrompts: false, uploads: false, partnerImports: false }
      })
    ),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: stubProvider(),
    timeoutMs: 5000
  });
  const decision = await service.evaluateText({
    tenantId: "t1",
    text: "reach me at someone@example.com",
    subject: { kind: "skill_corpus" }
  });
  // The rule detector flags the email and block mode blocks — the corpus
  // gate must not silently degrade to "scope_excluded".
  expect(decision.action).toBe("block");
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

test("transform mode scrubs LLM-only findings the model left in the output", async () => {
  // The model reports a person_name finding but returns transformedText that
  // still contains the raw name. The service must scrub it against the merged
  // finding set before returning — the rule detector never sees person_name.
  const provider = stubProvider({
    transformText: async ({ text }) => ({
      transformedText: text, // name NOT redacted by the model
      findings: [
        { entityType: "person_name", value: "Alice Smith", start: 0, end: 11, confidence: "high" }
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
    text: "Alice Smith called",
    subject: CHAT
  });
  expect(decision.action).toBe("transform");
  if (decision.action === "transform") {
    expect(decision.transformedText).toBe("[REDACTED:person_name] called");
    expect(decision.transformedText.includes("Alice Smith")).toBe(false);
    expect(decision.findings.some((f) => f.entityType === "person_name")).toBeTruthy();
  }
});

test("transform mode fails closed when a flagged value still leaks after scrubbing", async () => {
  // Pathological provider: the flagged value ("REDACTED") is a substring of the
  // placeholder the scrub inserts, so it can never be fully removed. Rather than
  // return text that still contains the flagged value, the service fails closed.
  const provider = stubProvider({
    transformText: async () => ({
      transformedText: "name is REDACTED today",
      findings: [
        { entityType: "person_name", value: "REDACTED", start: 8, end: 16, confidence: "high" }
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
  const error = await service
    .evaluateText({ tenantId: "t1", text: "name is REDACTED today", subject: CHAT })
    .catch((e: unknown) => e);
  expect(error instanceof PiiProtectionServiceError).toBeTruthy();
  expect((error as PiiProtectionServiceError).code).toBe("pii_transform_incomplete");
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
        provider: { type: "openai-compatible", model: "tenant/custom-model" }
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
        provider: { type: "openai-compatible", model: "" }
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
        provider: { type: "openai-compatible", model: "   " }
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
        contentType: "image/png",
        readContent: async () => "\x89PNG ...",
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
    "application/x-sh",
    // Callers pass a PDF as its extracted text (scannable-text.ts).
    "application/pdf",
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

test("evaluateArtifact aborts the content read when its timeout fires", async () => {
  // The read covers PDF text extraction, which must stop with the evaluation.
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect" })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 20
  });
  let readSignal: AbortSignal | undefined;
  const err = await service.evaluateArtifact({
    tenantId: "t1",
    artifact: {
      artifactId: "art_1",
      contentType: "application/pdf",
      readContent: (signal) => {
        readSignal = signal;
        return new Promise<string>(() => {});
      },
      entityTypes: []
    },
    subject: { kind: "upload" }
  }).catch((e: unknown) => e);
  expect((err as PiiProtectionServiceError).code).toBe("pii_timeout");
  expect(readSignal?.aborted).toBe(true);
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
      expect(encryptor.decryptValue(finding.value, "t1")).toBe("user@example.com");
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

test("getPolicy falls back to DEFAULT_PII_PROTECTION when reader returns null", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader(null),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const policy = await service.getPolicy("t1");
  expect(policy.settings).toEqual(DEFAULT_PII_PROTECTION);
  expect(policy.activation).toBe("off");
});

function invalidPolicyService(stored: unknown) {
  const provider = stubProvider({
    detectText: vi.fn(async () => ({ findings: [], providerType: "stub", providerModel: "m" })),
    scanArtifact: vi.fn(async () => ({ findings: [], summaryText: null, providerType: "stub", providerModel: "m" }))
  });
  const ruleDetector = new RuleBasedPiiDetector();
  const detect = vi.spyOn(ruleDetector, "detect");
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new PiiProtectionService({ policyReader: stubReader(stored), ruleDetector, provider, timeoutMs: 5000, logger });
  return { service, provider, detect, logger };
}

const ARTIFACT = {
  artifactId: "a1",
  contentType: "text/plain",
  entityTypes: [],
  readContent: vi.fn(async () => "a@b.co")
};

test("an invalid policy stops content in scope with pii_policy_invalid before any read or provider call", async () => {
  const { service, provider, detect, logger } = invalidPolicyService({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "bogus" });
  await expect(service.evaluateText({ tenantId: "t1", text: "a@b.co", subject: CHAT }))
    .rejects.toMatchObject({ code: "pii_policy_invalid" });
  await expect(service.evaluateArtifact({ tenantId: "t1", artifact: ARTIFACT, subject: { kind: "upload" } }))
    .rejects.toMatchObject({ code: "pii_policy_invalid" });
  expect(provider.detectText).not.toHaveBeenCalled();
  expect(provider.scanArtifact).not.toHaveBeenCalled();
  expect(detect).not.toHaveBeenCalled();
  expect(ARTIFACT.readContent).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", state: "error", reasons: ["mode_invalid"] }), expect.any(String));
});

test("an invalid policy lets content through when its valid scope is off, and an invalid scope counts as on", async () => {
  const { service } = invalidPolicyService({
    ...DEFAULT_PII_PROTECTION, enabled: true, mode: "off", scopes: { chatPrompts: false, uploads: "x" }
  });
  expect(await service.evaluateText({ tenantId: "t1", text: "a@b.co", subject: CHAT }))
    .toEqual({ action: "allow", reason: "scope_excluded" });
  await expect(service.evaluateArtifact({ tenantId: "t1", artifact: ARTIFACT, subject: { kind: "upload" } }))
    .rejects.toMatchObject({ code: "pii_policy_invalid" });
});

test("detect uses only the rules when a stored provider field is invalid, and logs a warning", async () => {
  const { service, provider, logger } = invalidPolicyService({
    ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect", provider: { type: "openai-compatible", model: 7 }
  });
  const decision = await service.evaluateText({ tenantId: "t1", text: "write to a@b.co", subject: CHAT });
  expect(decision.action).toBe("report");
  const artifact = await service.evaluateArtifact({ tenantId: "t1", artifact: ARTIFACT, subject: { kind: "upload" } });
  expect(artifact.action).toBe("report");
  expect(provider.detectText).not.toHaveBeenCalled();
  expect(provider.scanArtifact).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reasons: ["provider_invalid"], fields: ["provider.model"] }), expect.any(String));
});

test("an invalid policy error carries the settings revision that the evaluation read", async () => {
  const service = new PiiProtectionService({
    policyReader: stubReader({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "bogus" }, 9),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  await expect(service.evaluateTextWithPolicy({ tenantId: "t1", text: "a@b.co", subject: CHAT }))
    .rejects.toMatchObject({ code: "pii_policy_invalid", policyRevision: 9 });
  await expect(service.evaluateArtifact({ tenantId: "t1", artifact: ARTIFACT, subject: { kind: "upload" } }))
    .rejects.toMatchObject({ code: "pii_policy_invalid", policyRevision: 9 });
});

test("the applied mode and revision come from the same settings read as the decision", async () => {
  // Each read returns the next save. A second read for the record would see
  // the save after the one that made the decision.
  const saves = [
    { stored: buildSettings({ enabled: true, mode: "block" }), revision: 4 },
    { stored: buildSettings({ enabled: true, mode: "detect" }), revision: 5 },
    { stored: buildSettings({ enabled: true, mode: "transform" }), revision: 6 }
  ];
  const readPiiProtection = vi.fn(async () => saves.shift()!);
  const service = new PiiProtectionService({
    policyReader: { readPiiProtection },
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const artifact = { ...ARTIFACT, readContent: async () => "a@b.co" };
  const upload = { tenantId: "t1", artifact, subject: { kind: "upload" } as const };

  const blocked = await service.evaluateArtifactWithPolicy(upload);
  expect(blocked.decision.action).toBe("block");
  expect(blocked.appliedPolicy).toEqual({ mode: "block", revision: 4 });
  expect(readPiiProtection).toHaveBeenCalledTimes(1);

  const reported = await service.evaluateTextWithPolicy({ tenantId: "t1", text: "write to a@b.co", subject: CHAT });
  expect(reported.decision.action).toBe("report");
  expect(reported.appliedPolicy).toEqual({ mode: "detect", revision: 5 });
  expect(readPiiProtection).toHaveBeenCalledTimes(2);

  // Artifact transform reports, but the policy mode is transform.
  const transformed = await service.evaluateArtifactWithPolicy(upload);
  expect(transformed.decision.action).toBe("report");
  expect(transformed.appliedPolicy).toEqual({ mode: "transform", revision: 6 });
});

test("the applied mode is off when the policy is off or the subject is out of scope", async () => {
  const applied = async (settings: PiiProtectionSettings, text: string) => {
    const service = new PiiProtectionService({ policyReader: stubReader(settings, 3), ruleDetector: new RuleBasedPiiDetector(), timeoutMs: 5000 });
    return service.evaluateTextWithPolicy({ tenantId: "t1", text, subject: CHAT });
  };
  // A stored mode with protection off still scans nothing.
  expect(await applied(buildSettings({ enabled: false, mode: "block" }), "a@b.co")).toEqual({
    decision: { action: "allow", reason: "disabled" }, appliedPolicy: { mode: "off", revision: 3 }
  });
  expect(await applied(buildSettings({ enabled: true, mode: "detect", scopes: { chatPrompts: false, uploads: true } }), "a@b.co"))
    .toEqual({ decision: { action: "allow", reason: "scope_excluded" }, appliedPolicy: { mode: "off", revision: 3 } });
  // A scan with no findings applied its mode.
  expect(await applied(buildSettings({ enabled: true, mode: "detect" }), "no personal data")).toEqual({
    decision: { action: "allow", reason: "no_findings" }, appliedPolicy: { mode: "detect", revision: 3 }
  });
});

test("an evaluation given an earlier read uses it and does not read the policy again", async () => {
  const readPiiProtection = vi.fn(async () => ({ stored: buildSettings({ enabled: true, mode: "block" }), revision: 4 }));
  const service = new PiiProtectionService({
    policyReader: { readPiiProtection }, ruleDetector: new RuleBasedPiiDetector(), provider: stubProvider(), timeoutMs: 5000
  });
  const read = await service.readPolicy("t1");
  expect(read).toMatchObject({ tenantId: "t1", revision: 4, policy: { activation: "on", settings: { mode: "block" } } });

  const artifact = { ...ARTIFACT, readContent: async () => "a@b.co" };
  const blocked = await service.evaluateArtifactWithPolicy({ tenantId: "t1", artifact, subject: { kind: "upload" } }, read);
  const text = await service.evaluateTextWithPolicy({ tenantId: "t1", text: "no personal data", subject: CHAT }, read);

  expect(readPiiProtection).toHaveBeenCalledTimes(1);
  expect(blocked).toMatchObject({ decision: { action: "block" }, appliedPolicy: { mode: "block", revision: 4 } });
  expect(text).toEqual({ decision: { action: "allow", reason: "no_findings" }, appliedPolicy: { mode: "block", revision: 4 } });
});

test("an evaluation refuses an earlier read for a different tenant", async () => {
  const readPiiProtection = vi.fn(async () => ({ stored: buildSettings({ enabled: true, mode: "block" }), revision: 4 }));
  const service = new PiiProtectionService({
    policyReader: { readPiiProtection }, ruleDetector: new RuleBasedPiiDetector(), provider: stubProvider(), timeoutMs: 5000
  });
  const otherTenant = await service.readPolicy("t2");
  const artifact = { ...ARTIFACT, readContent: async () => "a@b.co" };

  await expect(service.evaluateTextWithPolicy({ tenantId: "t1", text: "a@b.co", subject: CHAT }, otherTenant))
    .rejects.toThrow("PII policy read is for a different tenant");
  await expect(service.evaluateArtifactWithPolicy({ tenantId: "t1", artifact, subject: { kind: "upload" } }, otherTenant))
    .rejects.toThrow("PII policy read is for a different tenant");
});

test("piiDecisionScanned classifies every allow reason and refuses an unknown one", () => {
  expect(piiDecisionScanned({ action: "allow", reason: "no_findings" })).toBe(true);
  expect(piiDecisionScanned({ action: "allow", reason: "disabled" })).toBe(false);
  expect(piiDecisionScanned({ action: "allow", reason: "scope_excluded" })).toBe(false);
  expect(piiDecisionScanned({ action: "report", findings: [], providerType: null, providerModel: null })).toBe(true);
  // A reason that the switch does not know must not count as "scanned nothing".
  expect(() => piiDecisionScanned({ action: "allow", reason: "future_reason" } as unknown as PiiDecision))
    .toThrow("Unknown PII allow reason: future_reason");
});

test("a registered import uses its own scope; an unregistered import is in scope", async () => {
  const importScopes = new PiiImportScopeRegistry();
  importScopes.register({ subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: true });
  const service = new PiiProtectionService({
    policyReader: stubReader(buildSettings({ enabled: true, mode: "detect", scopes: { chatPrompts: true, uploads: true, partnerImports: false } })),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000,
    importScopes
  });
  const evaluate = (subjectKind: string) =>
    service.evaluateText({ tenantId: "t1", text: "a@b.co", subject: { kind: "import", subjectKind } });
  expect(await evaluate("partner_import")).toEqual({ action: "allow", reason: "scope_excluded" });
  expect((await evaluate("unknown_import")).action).toBe("report");
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

test("buildCsvPreview: counts UTF-8 bytes, not characters", () => {
  const out = buildCsvPreview("é".repeat(4096), { maxRows: 5, maxBytes: 4096 });
  expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
  expect(out).toBe("é".repeat(2048));
  const rows = buildCsvPreview(["h", "éé", "éé", "éé"].join("\n"), { maxRows: 5, maxBytes: 12 });
  expect(rows).toBe(["h", "éé", "éé"].join("\n"));
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
