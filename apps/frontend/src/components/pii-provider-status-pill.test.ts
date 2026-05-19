import { test, expect } from "vitest";

import { __TEST__ } from "./pii-provider-status-pill";
import type { PiiProviderStatus } from "@cogniplane/shared-types";

const { resolvePill } = __TEST__;

test("resolvePill: null status returns neutral", () => {
  const pill = resolvePill(null, 1_000_000);
  expect(pill.variant).toBe("neutral");
  expect(pill.label).toBe("PII provider: unknown");
});

test("resolvePill: closed with no failures shows OK without detail", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "closed",
    failureCount: 0,
    openedAt: null,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_000_000);
  expect(pill.variant).toBe("ok");
  expect(pill.label).toBe("PII provider: OK");
  expect(pill.detail).toBe(null);
});

test("resolvePill: closed with recent failures shows OK with count detail", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "closed",
    failureCount: 3,
    openedAt: null,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_000_000);
  expect(pill.variant).toBe("ok");
  expect(pill.detail ?? "").toMatch(/3 recent failures/);
});

test("resolvePill: closed with one failure uses singular form", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "closed",
    failureCount: 1,
    openedAt: null,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_000_000);
  expect(pill.detail ?? "").toMatch(/^1 recent failure /);
});

test("resolvePill: half_open shows probing variant", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "half_open",
    failureCount: 0,
    openedAt: null,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_000_000);
  expect(pill.variant).toBe("probing");
  expect(pill.detail ?? "").toMatch(/Testing recovery/);
});

test("resolvePill: open with willRetryAt in the future shows countdown in seconds", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "open",
    failureCount: 5,
    openedAt: 1_000_000,
    willRetryAt: 1_030_000 // 30s after openedAt
  };
  const pill = resolvePill(status, 1_010_000); // 20s remaining
  expect(pill.variant).toBe("outage");
  expect(pill.detail ?? "").toMatch(/Will retry in ~20s/);
});

test("resolvePill: open with willRetryAt already passed clamps to 0s (not negative)", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "open",
    failureCount: 5,
    openedAt: 1_000_000,
    willRetryAt: 1_030_000
  };
  // Now is past willRetryAt — shouldAllow on the next call would flip to
  // half_open, but the snapshot we have here is stale. Detail should not
  // show a negative number.
  const pill = resolvePill(status, 1_100_000);
  expect(pill.detail ?? "").toMatch(/Will retry in ~0s/);
});

test("resolvePill: open with no willRetryAt falls back to generic detail", () => {
  const status: PiiProviderStatus = {
    provider: "openrouter",
    state: "open",
    failureCount: 5,
    openedAt: 1_000_000,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_010_000);
  expect(pill.variant).toBe("outage");
  expect(pill.detail).toBe("Provider unavailable");
});
