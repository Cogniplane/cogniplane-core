import { test, expect } from "vitest";

import {
  DEFAULT_PII_PROTECTION,
  PiiProtectionSettingsRequestSchema,
  PiiProtectionSettingsSchema
} from "@cogniplane/shared-types";

import { parsePiiProtection } from "./pii-policy.js";

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

test("parsePiiProtection preserves future persisted fields", () => {
  const result = parsePiiProtection({
    ...DEFAULT_PII_PROTECTION,
    futureOption: true
  });
  expect(result).toHaveProperty("futureOption", true);
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

test("the request schema rejects unknown entityType values", () => {
  const parsed = PiiProtectionSettingsRequestSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    detectors: { useRulesFirst: true, entityTypes: ["credit_card"] }
  });
  expect(parsed.success).toBe(false);
});

test("the request schema rejects missing required fields", () => {
  const { enabled: _enabled, ...withoutEnabled } = DEFAULT_PII_PROTECTION;
  void _enabled;
  const parsed = PiiProtectionSettingsRequestSchema.safeParse(withoutEnabled);
  expect(parsed.success).toBe(false);
});

test("the request schema accepts an empty provider model (=use provider default)", () => {
  const parsed = PiiProtectionSettingsRequestSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "" }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("");
  }
});

test("the request schema trims whitespace-only provider models to empty string", () => {
  const parsed = PiiProtectionSettingsRequestSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "   " }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("");
  }
});

test("the request schema trims provider model whitespace", () => {
  const parsed = PiiProtectionSettingsRequestSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { type: "openai-compatible", model: "  my-model  " }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider.model).toBe("my-model");
  }
});

test("the shared response schema preserves unknown fields", () => {
  const parsed = PiiProtectionSettingsSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { ...DEFAULT_PII_PROTECTION.provider, model: "  model-x  ", futureOption: true }
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.provider).toMatchObject({ model: "model-x", futureOption: true });
  }
});

test("the shared request schema rejects unknown fields", () => {
  const parsed = PiiProtectionSettingsRequestSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    unexpected: true
  });
  expect(parsed.success).toBe(false);
});
