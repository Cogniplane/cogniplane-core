// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdminSessionDetailMessage, AdminSessionDetailPiiRun } from "@cogniplane/shared-types";

import { AdminChatReplay } from "./admin-chat-replay";

afterEach(cleanup);

function message(overrides: Partial<AdminSessionDetailMessage>): AdminSessionDetailMessage {
  return {
    messageId: "m1", role: "user", status: "completed", contentText: "", reasoningContent: "", planContent: "",
    modelName: null, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, detailJson: null,
    createdAt: "2026-10-03T12:00:00.000Z", ...overrides
  };
}

// An inline run stores the session id as its subject, so only the scanRunId in
// the message's detailJson links it to the message.
const piiRun: AdminSessionDetailPiiRun = {
  scanRunId: "scan-1", subjectType: "message", subjectId: "s1", sourceUserId: null, mode: "block",
  providerType: null, providerModel: null, status: "completed", findings: [], summaryText: null,
  actionTaken: "blocked", errorMessage: null, createdAt: "2026-10-03T12:00:00.000Z", completedAt: null
};

// The first render loads react-markdown lazily, which can be slow on a busy runner.
// Below the 5 s test timeout, so a slow load fails with the DOM dump.
const MARKDOWN_LOAD = { timeout: 3_000 };

it("says when the session has no messages", () => {
  render(<AdminChatReplay messages={[]} piiRuns={[]} />);

  expect(screen.getByText("This session has no messages yet.")).toBeTruthy();
});

it("shows user text as typed and never shows reasoning or a plan for the user", async () => {
  render(<AdminChatReplay
    messages={[
      message({ contentText: "**not bold**", reasoningContent: "hidden", planContent: "hidden" }),
      message({ messageId: "m2" }),
      message({ messageId: "m3", role: "assistant", contentText: "**bold**" })
    ]}
    piiRuns={[]}
  />);

  // SafeMarkdown shows raw text until its renderer loads. Wait for it, so the
  // user text below is checked after markdown could have applied.
  expect((await screen.findByText("bold", {}, MARKDOWN_LOAD)).tagName).toBe("STRONG");
  expect(screen.getAllByText("User")).toHaveLength(2);
  expect(screen.getByText("**not bold**")).toBeTruthy();
  expect(screen.getByText("(empty message)")).toBeTruthy();
  expect(screen.queryByText("Thinking")).toBeNull();
  expect(screen.queryByText("Plan")).toBeNull();
  expect(screen.queryByText("hidden")).toBeNull();
});

it("shows the agent's thinking, plan, rendered answer, and model usage", async () => {
  render(<AdminChatReplay
    messages={[message({
      role: "assistant", contentText: "**Done**", reasoningContent: "Check the file.", planContent: "1. Read it",
      modelName: "Claude Sonnet 5", totalTokens: 1200, costUsd: 0.0123
    })]}
    piiRuns={[]}
  />);

  expect(screen.getByText("Agent")).toBeTruthy();
  expect(screen.getByText("Thinking")).toBeTruthy();
  expect(screen.getByText("Plan")).toBeTruthy();
  // SafeMarkdown loads its renderer lazily.
  expect((await screen.findByText("Done", {}, MARKDOWN_LOAD)).tagName).toBe("STRONG");
  expect(screen.getByText("Check the file.")).toBeTruthy();
  expect(screen.getByText("Read it")).toBeTruthy();
  expect(screen.getByText("Claude Sonnet 5 · 1200 tok · $0.0123")).toBeTruthy();
});

it("marks a failed agent message as an error", () => {
  const { container } = render(<AdminChatReplay
    messages={[message({ role: "assistant", status: "failed", contentText: "partial" })]}
    piiRuns={[]}
  />);

  expect(container.querySelector("article")!.className).toContain("border-danger");
  expect(screen.getByText("failed").className).toContain("text-danger");
});

it("attaches the PII run that the message links to", () => {
  render(<AdminChatReplay
    messages={[message({ contentText: "my card", detailJson: { pii: { scanRunId: "scan-1" } } })]}
    piiRuns={[piiRun]}
  />);

  expect(screen.getByText(/^PII completed/)).toBeTruthy();
  expect(screen.getByText("Mode: block · action: blocked")).toBeTruthy();
});
