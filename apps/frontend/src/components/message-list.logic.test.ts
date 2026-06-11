import { describe, expect, test } from "vitest";
import type { Message } from "@cogniplane/shared-types";

import { formatCostUsd, formatTokenCount, shouldShowRetry } from "./message-list.logic";

function asMessage(overrides: Partial<Message>): Message {
  return { ...({} as Message), ...overrides } as Message;
}

describe("formatTokenCount", () => {
  test("handles all magnitude buckets", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(15000)).toBe("15k");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  test("strips redundant .0 suffix", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(2_000_000)).toBe("2m");
  });
});

describe("formatCostUsd", () => {
  test("very small costs use the < threshold display", () => {
    expect(formatCostUsd(0.00001)).toBe("<$0.0001");
  });

  test("small costs render with 4-decimal precision", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
  });

  test("normal costs use 3-decimal precision", () => {
    expect(formatCostUsd(0.123)).toBe("$0.123");
  });
});

describe("shouldShowRetry", () => {
  test("only when last assistant message is in error and onRetry is provided", () => {
    expect(shouldShowRetry([asMessage({ role: "assistant", status: "error" })], true)).toBe(true);
    expect(shouldShowRetry([asMessage({ role: "assistant", status: "error" })], false)).toBe(false);
    expect(shouldShowRetry([asMessage({ role: "assistant", status: "completed" })], true)).toBe(false);
    expect(shouldShowRetry([asMessage({ role: "user", status: "error" })], true)).toBe(false);
    expect(shouldShowRetry([], true)).toBe(false);
  });
});
