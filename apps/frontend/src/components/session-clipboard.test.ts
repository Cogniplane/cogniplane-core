import { describe, expect, test } from "vitest";
import type { Message } from "@cogniplane/shared-types";

import { formatSessionForClipboard } from "./session-clipboard";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    role: "user",
    content: "",
    status: "completed",
    ...overrides
  } as Message;
}

describe("formatSessionForClipboard", () => {
  test("returns undefined for an empty session", () => {
    expect(formatSessionForClipboard([])).toBeUndefined();
  });

  test("formats only completed/streaming messages with role labels", () => {
    const messages = [
      makeMessage({ role: "user", content: "hi", status: "completed" }),
      makeMessage({ role: "assistant", content: "hello", status: "streaming" }),
      makeMessage({ role: "user", content: "draft", status: "pending" })
    ];
    expect(formatSessionForClipboard(messages)).toBe("You:\nhi\n\n---\n\nAgent:\nhello");
  });
});
