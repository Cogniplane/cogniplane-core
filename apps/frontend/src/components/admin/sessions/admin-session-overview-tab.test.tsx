// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSessionDetailOverview } from "@cogniplane/shared-types";

import { AdminSessionOverviewTab } from "./admin-session-overview-tab";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

const overview: AdminSessionDetailOverview = {
  sessionId: "s1", userId: "u1", userEmail: "ana@example.com", tenantId: "t1", sessionName: "Quarterly report",
  status: "active", runtimeProvider: "deep-agents", createdAt: "2026-10-01T10:00:00.000Z",
  lastActivityAt: "2026-10-01T11:00:00.000Z", messageCount: 4, totalCostUsd: 0.12345, totalTokens: 1200
};

/** The value shown under a field's label. */
const valueOf = (label: string) => screen.getByText(label).closest("div")!.nextElementSibling!.textContent;

it("shows each field, with the user's email and id together", () => {
  render(<AdminSessionOverviewTab overview={overview} />);

  expect(valueOf("User")).toBe("ana@example.com (u1)");
  expect(valueOf("Tenant ID")).toBe("t1");
  expect(valueOf("Session ID")).toBe("s1");
  expect(valueOf("Session name")).toBe("Quarterly report");
  expect(valueOf("Message count")).toBe("4");
  expect(valueOf("Total cost")).toBe("$0.1235");
  expect(valueOf("Total tokens")).toBe((1200).toLocaleString());
});

it("shows a dash, with no copy button, for empty values", () => {
  render(<AdminSessionOverviewTab overview={{ ...overview, userEmail: null, sessionName: "", totalCostUsd: 0, totalTokens: 0 }} />);

  expect(valueOf("User")).toBe("u1");
  expect(valueOf("Session name")).toBe("—");
  expect(valueOf("Total cost")).toBe("—");
  expect(valueOf("Total tokens")).toBe("—");
  expect(screen.queryByRole("button", { name: "Copy Session name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy Total cost" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy Session ID" })).toBeTruthy();
});

it("copies a field's value", () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<AdminSessionOverviewTab overview={overview} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy Tenant ID" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy User" }));

  expect(writeText.mock.calls).toEqual([["t1"], ["ana@example.com (u1)"]]);
});
