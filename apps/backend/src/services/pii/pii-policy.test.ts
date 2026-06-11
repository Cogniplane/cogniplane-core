import { test, expect } from "vitest";

import {
  DEFAULT_PII_PROTECTION,
  parsePiiProtection,
  piiProtectionSchema
} from "./pii-policy.js";

test("parsePiiProtection returns defaults for undefined input", () => {
  const result = parsePiiProtection(undefined);
  expect(result).toEqual(DEFAULT_PII_PROTECTION);
});

test("parsePiiProtection returns defaults for null input", () => {
  const result = parsePiiProtection(null);
  expect(result).toEqual(DEFAULT_PII_PROTECTION);
});

test("parsePiiProtection returns defaults when mode enum is invalid", () => {
  const result = parsePiiProtection({
    ...DEFAULT_PII_PROTECTION,
    mode: "bogus"
  });
  expect(result.mode).toBe("off");
});

test("parsePiiProtection returns defaults when rawRetention enum is invalid", () => {
  const result = parsePiiProtection({
    ...DEFAULT_PII_PROTECTION,
    rawRetention: "forever"
  });
  expect(result.rawRetention).toBe("never");
});

test("parsePiiProtection accepts a fully valid payload", () => {
  const input = {
    enabled: true,
    mode: "transform" as const,
    rawRetention: "admin_only" as const,
    provider: { type: "openai-compatible" as const, model: "model-x" },
    scopes: { chatPrompts: true, uploads: true, microsoftImports: false },
    actions: { reportToAdmins: false },
    detectors: {
      useRulesFirst: false,
      entityTypes: ["email" as const, "government_id" as const]
    }
  };
  const result = parsePiiProtection(input);
  expect(result).toEqual(input);
});

test("piiProtectionSchema rejects unknown entityType values", () => {
  const parsed = piiProtectionSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    detectors: { useRulesFirst: true, entityTypes: ["credit_card"] }
  });
  expect(parsed.success).toBe(false);
});

test("piiProtectionSchema rejects missing required field", () => {
  const { enabled: _enabled, ...withoutEnabled } = DEFAULT_PII_PROTECTION;
  void _enabled;
  const parsed = piiProtectionSchema.safeParse(withoutEnabled);
  expect(parsed.success).toBe(false);
});

test("piiProtectionSchema accepts empty provider model (=use provider default)", () => {
  const parsed = piiProtectionSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "" }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("");
  }
});

test("piiProtectionSchema trims whitespace-only provider model to empty string", () => {
  const parsed = piiProtectionSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "   " }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("");
  }
});

test("piiProtectionSchema trims provider model whitespace", () => {
  const parsed = piiProtectionSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "  my-model  " }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("my-model");
  }
});
