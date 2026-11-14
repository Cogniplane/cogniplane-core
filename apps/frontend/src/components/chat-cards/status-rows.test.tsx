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
