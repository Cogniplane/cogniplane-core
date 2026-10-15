import { describe, expect, it } from "vitest";

import { checkAppUserMessage, refusedMessageText } from "./mcp-app-frame.logic";
import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";

const text = (value: string) => [{ type: "text", text: value }];

describe("checkAppUserMessage", () => {
  it("accepts one visible user text block only when the chat is editable and idle", () => {
    const content = text("Draft a decision for HelpHarbor.");
    expect(checkAppUserMessage("user", content, true, false)).toEqual({ ok: true, text: "Draft a decision for HelpHarbor." });
    expect(checkAppUserMessage("assistant", content, true, false)).toEqual({ ok: false, reason: "unsupported" });
    expect(checkAppUserMessage("user", content, false, false)).toEqual({ ok: false, reason: "unavailable" });
    expect(checkAppUserMessage("user", content, true, true)).toEqual({ ok: false, reason: "unavailable" });
    expect(checkAppUserMessage("user", [...content, ...content], true, false)).toEqual({ ok: false, reason: "unsupported" });
    expect(checkAppUserMessage("user", [{ type: "image", data: "x" }], true, false)).toEqual({ ok: false, reason: "unsupported" });
    expect(checkAppUserMessage("user", text("  \n "), true, false)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("keeps the text as it is, with leading blank lines and control characters", () => {
    const raw = "\n\n  ask\u202E\u0001";
    expect(checkAppUserMessage("user", text(raw), true, false)).toEqual({ ok: true, text: raw });
  });

  it("accepts text up to the limit and refuses more, with its length", () => {
    expect(checkAppUserMessage("user", text("x".repeat(MCP_APP_MESSAGE_MAX_CHARS)), true, false).ok).toBe(true);
    expect(checkAppUserMessage("user", text("x".repeat(MCP_APP_MESSAGE_MAX_CHARS + 1)), true, false))
      .toEqual({ ok: false, reason: "too-long", length: MCP_APP_MESSAGE_MAX_CHARS + 1 });
    // The old limit was 100,000. A message in between is refused now.
    expect(checkAppUserMessage("user", text("x".repeat(50_000)), true, false).ok).toBe(false);
  });

  it("does not report a size problem for a chat that cannot take a message", () => {
    expect(checkAppUserMessage("user", text("x".repeat(5_000)), false, false)).toEqual({ ok: false, reason: "unavailable" });
    expect(checkAppUserMessage("user", text("x".repeat(5_000)), true, true)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("refusedMessageText", () => {
  it("explains a message that is too long, with both numbers", () => {
    expect(refusedMessageText({ ok: false, reason: "too-long", length: 5_200 }))
      .toBe("A tool view tried to send a message of 5,200 characters. The limit is 4,000 characters, so the chat did not accept it.");
  });

  it("stays quiet for other refusals and for an accepted message", () => {
    expect(refusedMessageText({ ok: false, reason: "unavailable" })).toBeNull();
    expect(refusedMessageText({ ok: false, reason: "unsupported" })).toBeNull();
    expect(refusedMessageText({ ok: true, text: "x" })).toBeNull();
  });
});
