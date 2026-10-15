// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdminSessionDetailAuditEvent } from "@cogniplane/shared-types";

import { AdminSessionAuditTab } from "./admin-session-audit-tab";

afterEach(cleanup);

function event(overrides: Partial<AdminSessionDetailAuditEvent>): AdminSessionDetailAuditEvent {
  return {
    eventType: "approval.granted", userId: "u1", approvalId: null, payload: null, ipAddress: null,
    userAgent: null, createdAt: "2026-10-01T10:00:00.000Z", ...overrides
  };
}

const longAgent = `Mozilla/5.0 ${"x".repeat(80)}`;

it("says when the session has no audit events", () => {
  render(<AdminSessionAuditTab auditEvents={[]} />);

  expect(screen.getByText("No audit events for this session.")).toBeTruthy();
});

it("shows each event's details, shortening a long user agent in the summary", () => {
  render(<AdminSessionAuditTab auditEvents={[
    event({ eventType: "approval.granted", approvalId: "ap-1", ipAddress: "10.0.0.1", userAgent: longAgent, payload: { tool: "shell" } }),
    // A payload the backend left out entirely.
    event({ eventType: "session.archived", userId: "u2", payload: undefined })
  ]} />);

  expect(screen.getByText("10.0.0.1")).toBeTruthy();
  expect(screen.getByText(/user u1 · approval ap-1$/)).toBeTruthy();
  expect(screen.getByText(/user u2$/)).toBeTruthy();
  // The summary keeps 59 characters and an ellipsis; the body shows all of it.
  expect(screen.getByText(`UA: ${longAgent.slice(0, 59)}…`)).toBeTruthy();
  expect(screen.getByText(longAgent)).toBeTruthy();
  expect(screen.getByText("ap-1")).toBeTruthy();
  expect(screen.getByText(/"tool": "shell"/)).toBeTruthy();
  // An event without a payload shows null rather than nothing.
  expect(screen.getByText("null")).toBeTruthy();
  // Optional fields stay out of the event that lacks them.
  expect(screen.getAllByText(/^UA:/)).toHaveLength(1);
  expect(screen.getAllByText("Approval ID:")).toHaveLength(1);
});

it("keeps a short user agent whole", () => {
  render(<AdminSessionAuditTab auditEvents={[event({ userAgent: "curl/8.0" })]} />);

  expect(screen.getByText("UA: curl/8.0")).toBeTruthy();
});

it("filters events by type, ignoring case and spaces", () => {
  render(<AdminSessionAuditTab auditEvents={[event({ eventType: "Approval.Granted" }), event({ eventType: "session.archived" })]} />);
  const filter = screen.getByLabelText("Filter by event type");

  fireEvent.change(filter, { target: { value: "  aPPROVAL " } });
  expect(screen.getByText("Approval.Granted")).toBeTruthy();
  expect(screen.queryByText("session.archived")).toBeNull();

  fireEvent.change(filter, { target: { value: "export" } });
  expect(screen.getByText("No events match this filter.")).toBeTruthy();
});
