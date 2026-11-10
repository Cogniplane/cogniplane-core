// @vitest-environment jsdom
import { Profiler, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { getPiiProviderStatus } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { QueryProvider } from "../lib/query-provider";
import { PiiProviderStatusPill, __TEST__ } from "./pii-provider-status-pill";
import type { PiiProviderStatus } from "@cogniplane/shared-types";

vi.mock("../lib/admin-api", () => ({ getPiiProviderStatus: vi.fn() }));

const { resolvePill } = __TEST__;

const closed: PiiProviderStatus = { provider: "pii-llm", state: "closed", failureCount: 0, openedAt: null, willRetryAt: null };

function outage(retryInMs: number): PiiProviderStatus {
  return { provider: "pii-llm", state: "open", failureCount: 5, openedAt: Date.now(), willRetryAt: Date.now() + retryInMs };
}

function accessError(status: number): ApiError {
  return new ApiError({ status, method: "GET", path: "/admin/pii/provider-status", message: "No access." });
}

function ClearQueryClientOnUnmount() {
  const client = useQueryClient();
  useEffect(() => () => client.clear(), [client]);
  return null;
}

// The production client, so the tests use the app's stale time and retry policy.
function mount(active?: boolean) {
  let commits = 0;
  const tree = (isActive?: boolean) => (
    <QueryProvider>
      <ClearQueryClientOnUnmount />
      <Profiler id="pill" onRender={() => { commits += 1; }}>
        <PiiProviderStatusPill active={isActive} />
      </Profiler>
    </QueryProvider>
  );
  const view = render(tree(active));
  return {
    rerender: (isActive: boolean) => view.rerender(tree(isActive)),
    commitsSince: () => { const count = commits; commits = 0; return count; }
  };
}

function setDocumentVisibility(state: DocumentVisibilityState) {
  act(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
}

// Query sends its updates to React on a 0 ms timer. The fake clock delays a
// 0 ms timer set during a step by 1 ms, so the second step runs the update of
// a read that ends at the end of the first step.
const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(1);
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
  vi.resetAllMocks();
});

test("reads the status every 10 s while the document is visible, and stops while it is hidden", async () => {
  vi.mocked(getPiiProviderStatus).mockResolvedValue(closed);
  mount();
  await advance(0);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(2);

  setDocumentVisibility("hidden");
  await advance(60_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(2);

  setDocumentVisibility("visible");
  await advance(10_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(3);
});

test("stops reading while its panel is not active, and reads again when it is", async () => {
  vi.mocked(getPiiProviderStatus).mockResolvedValue(closed);
  const pill = mount(true);
  await advance(0);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(1);

  pill.rerender(false);
  await advance(60_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(1);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();

  pill.rerender(true);
  await advance(0);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(2);
});

test.each([401, 403])("hides the pill and stops reading after a %i", async (status) => {
  vi.mocked(getPiiProviderStatus).mockResolvedValueOnce(closed).mockRejectedValue(accessError(status));
  mount();
  await advance(0);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();

  await advance(10_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/PII provider/)).toBeNull();

  await advance(60_000);
  expect(getPiiProviderStatus).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/PII provider/)).toBeNull();
});

test("shows unknown after other read failures and keeps reading", async () => {
  vi.mocked(getPiiProviderStatus).mockRejectedValue(new Error("Unavailable"));
  mount();
  await advance(5_000);
  expect(screen.getByText("PII provider: unknown")).toBeTruthy();

  vi.mocked(getPiiProviderStatus).mockResolvedValue(closed);
  await advance(10_000);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();
});

test("does not render an OK pill again between reads", async () => {
  vi.mocked(getPiiProviderStatus).mockResolvedValue(closed);
  const pill = mount();
  await advance(0);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();
  pill.commitsSince();

  // One act per second, so that React commits each clock update on its own.
  for (let second = 0; second < 5; second += 1) await advance(1_000);
  expect(pill.commitsSince()).toBe(0);
});

test("counts down during an outage, and the countdown stops while the document is hidden", async () => {
  vi.mocked(getPiiProviderStatus).mockResolvedValue(outage(30_000));
  mount();
  await advance(0);
  expect(screen.getByText(/Will retry in ~30s/)).toBeTruthy();
  await advance(5_000);
  expect(screen.getByText(/Will retry in ~25s/)).toBeTruthy();

  setDocumentVisibility("hidden");
  await advance(3_000);
  expect(screen.getByText(/Will retry in ~25s/)).toBeTruthy();

  setDocumentVisibility("visible");
  await advance(1_000);
  expect(screen.getByText(/Will retry in ~21s/)).toBeTruthy();
});

test("starts an outage countdown from the read time, also after a long OK period", async () => {
  vi.mocked(getPiiProviderStatus).mockResolvedValue(closed);
  mount();
  await advance(60_000);
  expect(screen.getByText("PII provider: OK")).toBeTruthy();

  vi.mocked(getPiiProviderStatus).mockImplementation(async () => outage(30_000));
  await advance(10_000);
  expect(screen.getByText(/Will retry in ~30s/)).toBeTruthy();
});

test("resolvePill: null status returns neutral", () => {
  const pill = resolvePill(null, 1_000_000);
  expect(pill.variant).toBe("neutral");
  expect(pill.label).toBe("PII provider: unknown");
});

test("resolvePill: closed with no failures shows OK without detail", () => {
  const status: PiiProviderStatus = {
    provider: "pii-llm",
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
    provider: "pii-llm",
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
    provider: "pii-llm",
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
    provider: "pii-llm",
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
    provider: "pii-llm",
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
    provider: "pii-llm",
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
    provider: "pii-llm",
    state: "open",
    failureCount: 5,
    openedAt: 1_000_000,
    willRetryAt: null
  };
  const pill = resolvePill(status, 1_010_000);
  expect(pill.variant).toBe("outage");
  expect(pill.detail).toBe("Provider unavailable");
});
