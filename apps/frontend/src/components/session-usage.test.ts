import { describe, expect, test } from "vitest";
import type { Message } from "@cogniplane/shared-types";

import { sessionCostUsd } from "./session-usage";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    role: "user",
    content: "",
    status: "completed",
    ...overrides
  } as Message;
}

describe("sessionCostUsd", () => {
  test("sums per-message costUsd, ignoring missing values", () => {
    const messages = [
      makeMessage({ costUsd: 0.002 }),
      makeMessage({ costUsd: undefined }),
      makeMessage({ costUsd: 0.013 })
    ];
    expect(sessionCostUsd(messages)).toBeCloseTo(0.015, 6);
  });

  test("is 0 for a session with no cost", () => {
    expect(sessionCostUsd([makeMessage({})])).toBe(0);
  });
});
