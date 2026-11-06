// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { RuntimeNoticeRow } from "./chat-cards.types";
import { RuntimeNoticeRowView } from "./status-rows";

afterEach(cleanup);

const row = (level: RuntimeNoticeRow["level"]): RuntimeNoticeRow => ({
  type: "runtime-notice", rowId: `n-${level}`, noticeId: `n-${level}`, level,
  title: `A ${level} notice`, message: `What the ${level} notice says.`, createdAt: "2026-11-04T10:00:00.000Z"
});

it.each([
  ["error", true],
  ["warning", true],
  ["info", false]
] as const)("opens a %s notice by default: %s, and clicking its summary toggles it", (level, open) => {
  const { container } = render(<RuntimeNoticeRowView row={row(level)} />);
  const details = container.querySelector("details")!;
  const summary = screen.getByText(`A ${level} notice`).closest("summary")!;

  expect(details.open).toBe(open);
  // The summary removes the default outline and keeps the shared focus ring.
  // jsdom draws nothing, so the browser check covers how the ring looks.
  expect(summary.className).toMatch(/\boutline-none\b/);
  expect(summary.className).toContain("focus-visible:ring-[3px]");
  expect(summary.className).toContain("focus-visible:ring-ring/50");
  // The icons are decoration. The title names the notice.
  expect(summary.querySelectorAll("svg:not([aria-hidden='true'])")).toHaveLength(0);

  fireEvent.click(summary);
  expect(details.open).toBe(!open);
});

it("keeps the server and status visible while the full error has a native disclosure", async () => {
  const { McpServerStatusRowView } = await import("./status-rows");
  const error = "First line\n" + "long unbroken error ".repeat(80) + "Final detail.";
  const { container } = render(<McpServerStatusRowView row={{ type: "mcp-server-status", rowId: "mcp-1", serverName: "Report server", status: "failed", error }} />);
  expect(screen.getByText("Report server · failed")).toBeTruthy();
  const details = container.querySelector("details")!;
  const summary = screen.getByText("Error details").closest("summary")!;
  expect(details.open).toBe(false);
  summary.focus();
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(details.querySelector("p")?.textContent).toBe(error);
  expect(screen.getByText("Report server · failed")).toBeTruthy();
});
