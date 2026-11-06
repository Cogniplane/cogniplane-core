// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";
import { AdminSessionDetailSidebar } from "./admin-session-detail-sidebar";

const location = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(location.query) }));
afterEach(() => { cleanup(); location.query = ""; });
const detail: AdminSessionDetailResponse = {
  overview: {
    sessionId: "session-1", userId: "user-1", userEmail: "user@example.test", tenantId: "tenant-1", sessionName: "Research",
    status: "active", runtimeProvider: "deep-agents", createdAt: "2026-09-26T00:00:00Z", lastActivityAt: "2026-09-26T00:00:00Z",
    messageCount: 0, totalCostUsd: 0, totalTokens: 0
  },
  messages: [], approvals: [], piiRuns: [], auditEvents: [], toolEvents: [], messageToolResults: [], artifacts: [], skills: [], mcpServers: []
};

it("opens conversation and keeps diagnostic views out of the primary tabs", () => {
  render(<AdminSessionDetailSidebar detail={detail} />);
  expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("This session has no messages yet.")).toBeTruthy();
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  expect(screen.queryByLabelText("Diagnostic view")).toBeNull();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Alerts" }), { button: 0, ctrlKey: false });
  expect(screen.getByText("No alerts in this session.")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Approvals" }), { button: 0, ctrlKey: false });
  expect(screen.getByText("No approvals in this session.")).toBeTruthy();
});

it("preserves diagnostic deep links and lets admins switch diagnostic views", () => {
  location.query = "tab=raw";
  render(<AdminSessionDetailSidebar detail={detail} />);
  expect(screen.getByRole("tab", { name: "Diagnostics" }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByLabelText("Diagnostic view") as HTMLSelectElement).value).toBe("raw");
  expect(screen.getByText("No messages in this session.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Diagnostic view"), { target: { value: "audit" } });
  expect(screen.getByText("No audit events for this session.")).toBeTruthy();
});

it("opens existing approval links directly", () => {
  location.query = "tab=approvals";
  render(<AdminSessionDetailSidebar detail={detail} />);
  expect(screen.getByRole("tab", { name: "Approvals" }).getAttribute("aria-selected")).toBe("true");
});

it("opens Conversation before focusing an alert's message without smooth motion", async () => {
  const { waitFor } = await import("@testing-library/react");
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    location.query = "tab=alerts";
    render(<AdminSessionDetailSidebar detail={{ ...detail, messages: [{ messageId: "m1", role: "assistant", status: "error", contentText: "Sample failure", reasoningContent: "", planContent: "", modelName: null, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, detailJson: {}, createdAt: "2026-10-01T00:00:00Z" }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Jump to message" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("message-m1"));
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
