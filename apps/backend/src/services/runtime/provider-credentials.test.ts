import { test, expect } from "vitest";

import type { AppConfig } from "../../config.js";
import { buildProviderCredentials } from "./provider-credentials.js";

const noConfig = {
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ZAI_API_KEY: undefined
} as Pick<
  AppConfig,
  "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | "OPENROUTER_API_KEY" | "ZAI_API_KEY"
>;

test("tenant key wins over the platform env key", async () => {
  const creds = buildProviderCredentials({
    config: { ...noConfig, OPENAI_API_KEY: "platform-openai" },
    getTenantProviderKey: async (_tenantId, provider) =>
      provider === "openai" ? "tenant-openai" : null
  });
  expect(await creds.resolveKey("t", "openai")).toBe("tenant-openai");
});

test("falls back to the platform env key when no tenant key", async () => {
  const creds = buildProviderCredentials({
    config: { ...noConfig, ANTHROPIC_API_KEY: "platform-anthropic" },
    getTenantProviderKey: async () => null
  });
  expect(await creds.resolveKey("t", "anthropic")).toBe("platform-anthropic");
  // A platform key satisfies presence for every tenant without a DB read.
  expect(creds.platformProviders.has("anthropic")).toBe(true);
  expect(await creds.hasKey("t", "anthropic")).toBe(true);
});

test("hasKey is false when neither tenant nor platform key exists", async () => {
  const creds = buildProviderCredentials({
    config: noConfig,
    getTenantProviderKey: async () => null
  });
  expect(await creds.hasKey("t", "google")).toBe(false);
  expect(await creds.resolveKey("t", "google")).toBe(null);
  expect(creds.platformProviders.size).toBe(0);
});

test("whitespace-only tenant/platform keys are treated as absent", async () => {
  const creds = buildProviderCredentials({
    config: { ...noConfig, OPENROUTER_API_KEY: "   " },
    getTenantProviderKey: async () => "  "
  });
  expect(await creds.hasKey("t", "openrouter")).toBe(false);
  expect(await creds.resolveKey("t", "openrouter")).toBe(null);
});

test("resolves the Z.AI provider (tenant key over platform, presence via platform)", async () => {
  const platformCreds = buildProviderCredentials({
    config: { ...noConfig, ZAI_API_KEY: "platform-zai" },
    getTenantProviderKey: async () => null
  });
  expect(await platformCreds.resolveKey("t", "zai")).toBe("platform-zai");
  expect(platformCreds.platformProviders.has("zai")).toBe(true);
  expect(await platformCreds.hasKey("t", "zai")).toBe(true);

  const tenantCreds = buildProviderCredentials({
    config: { ...noConfig, ZAI_API_KEY: "platform-zai" },
    getTenantProviderKey: async (_tenantId, provider) =>
      provider === "zai" ? "tenant-zai" : null
  });
  expect(await tenantCreds.resolveKey("t", "zai")).toBe("tenant-zai");
});
