// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PiiRecentResponse, PiiRecentRow, PiiTopResponse, PiiTopSessionRow, PiiTopUserRow } from "@cogniplane/shared-types";

import { getAdminPiiRecent, getAdminPiiTop } from "../../../lib/admin-api";
import { RecentActivityFeed, TopOffenders } from "./admin-pii-tables";

vi.mock("../../../lib/admin-api", () => ({ getAdminPiiRecent: vi.fn(), getAdminPiiTop: vi.fn() }));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function row(overrides: Partial<PiiRecentRow>): PiiRecentRow {
  return {
    scanRunId: "scan-1", createdAt: "2026-10-01T10:00:00.000Z", completedAt: null, subjectType: "message",
    subjectId: "msg-1234567890", sessionId: "session/1", userId: "u1", mode: "block", actionTaken: "blocked",
    status: "completed", providerType: null, providerModel: null, findingsCount: 2, errorMessage: null,
    entityTypes: ["EMAIL", "PHONE"], ...overrides
  };
}

function renderFeed(rows: PiiRecentRow[]) {
  const response: PiiRecentResponse = { range: { preset: "7d", from: "2026-09-24", to: "2026-10-01" }, actions: [], rows };
  vi.mocked(getAdminPiiRecent).mockResolvedValue(response);
  return renderWithClient(<RecentActivityFeed range="7d" />);
}

it("says when the range has no blocked, transformed, or failed scans", async () => {
  renderFeed([]);

  expect(await screen.findByText("No blocked, transformed, or failed scans in this range.")).toBeTruthy();
});

it("links a scan to its session's PII tab and names what was scanned", async () => {
  renderFeed([row({})]);

  const link = (await screen.findByText(/^Message/)).closest("a")!;
  expect(link.getAttribute("href")).toBe("/admin/sessions/session%2F1?tab=pii");
  expect(screen.getByText(/^2 findings: EMAIL, PHONE/)).toBeTruthy();
});

it("shows a scan without a session as a plain row", async () => {
  renderFeed([row({ sessionId: null, subjectType: "artifact", findingsCount: 1, entityTypes: [] })]);

  expect((await screen.findByText(/^Artifact/)).closest("a")).toBeNull();
  expect(screen.getByText(/^1 finding •/)).toBeTruthy();
});

it("names project instructions with their revision and shows a failed scan's error", async () => {
  renderFeed([row({
    subjectType: "project_instructions", instructionsRevision: 3, status: "failed", findingsCount: 0,
    entityTypes: [], errorMessage: "provider timeout", providerType: "openai"
  })]);

  expect(await screen.findByText(/^Project instructions .* · Revision 3$/)).toBeTruthy();
  expect(screen.getByText(/^0 findings — provider timeout/)).toBeTruthy();
  expect(screen.getByText("openai")).toBeTruthy();
});

// ─── TopOffenders ──────────────────────────────────────────────────────────

const RANGE = { preset: "7d", from: "2026-09-24", to: "2026-10-01" } as const;

function userRow(userId: string, overrides: Partial<PiiTopUserRow> = {}): PiiTopUserRow {
  return {
    userId, findingsTotal: 3, sessionsCount: 2, blockCount: 1, transformCount: 2, failedCount: 0,
    lastSeenAt: "2026-10-01T10:00:00.000Z", ...overrides
  };
}

function sessionRow(sessionId: string, overrides: Partial<PiiTopSessionRow> = {}): PiiTopSessionRow {
  return {
    sessionId, userId: "user-abcdefghijk", findingsTotal: 1,
    actionMix: { allow: 0, report: 0, block: 0, transform: 0, failed: 1 },
    lastActivityAt: null, ...overrides
  };
}

function renderTop(users: PiiTopUserRow[], sessions: PiiTopSessionRow[]) {
  vi.mocked(getAdminPiiTop).mockImplementation(async (params): Promise<PiiTopResponse> =>
    params.groupBy === "user"
      ? { range: RANGE, groupBy: "user", rows: users }
      : { range: RANGE, groupBy: "session", rows: sessions });
  return renderWithClient(<TopOffenders range="7d" />);
}

const linkOf = (text: string) => screen.getByText(text).closest("a")!.getAttribute("href");

it("lists users by findings, links each to its person page, and shows only non-zero actions", async () => {
  renderTop([userRow("user/1"), userRow("user-abcdefghijk", { findingsTotal: 1, sessionsCount: 1, blockCount: 0, transformCount: 0, failedCount: 1, lastSeenAt: null })], []);

  expect(await screen.findByText("user/1")).toBeTruthy();
  expect(linkOf("user/1")).toBe("/admin/users/user%2F1");
  // Long ids are shortened; the full id stays in the title.
  expect(screen.getByTitle("user-abcdefghijk").textContent).toBe("user-abc…");
  expect(screen.getByText("1 blocked")).toBeTruthy();
  expect(screen.getByText("2 transformed")).toBeTruthy();
  expect(screen.getAllByText(/failed$/).map((pill) => pill.textContent)).toEqual(["1 failed"]);
  // Zero counts get no pill.
  expect(screen.queryByText(/^0 (blocked|transformed|failed)$/)).toBeNull();
  expect(screen.getByText(/^3 findings across 2 sessions/)).toBeTruthy();
  expect(screen.getByText(/^1 finding across 1 session •/)).toBeTruthy();
  expect(getAdminPiiTop).toHaveBeenCalledWith({ range: "7d", groupBy: "user" });
});

it("switches to sessions, linking each to its PII tab and naming its user", async () => {
  renderTop([userRow("u1")], [
    sessionRow("session/1", { findingsTotal: 4, actionMix: { allow: 1, report: 0, block: 2, transform: 1, failed: 0 } }),
    sessionRow("s2", { userId: null })
  ]);
  await screen.findByText("u1");

  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));

  expect(await screen.findByText("session/1")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Sessions" }).getAttribute("aria-selected")).toBe("true");
  expect(linkOf("session/1")).toBe("/admin/sessions/session%2F1?tab=pii");
  expect(linkOf("s2")).toBe("/admin/sessions/s2?tab=pii");
  expect(screen.getByText("2 blocked")).toBeTruthy();
  expect(screen.getByText("1 transformed")).toBeTruthy();
  expect(screen.getByText("1 failed")).toBeTruthy();
  expect(screen.getByText(/^4 findings • user user-abc… •/)).toBeTruthy();
  // Zero counts get no pill.
  expect(screen.queryByText(/^0 (blocked|transformed|failed)$/)).toBeNull();
  // Without a user, the line names none.
  expect(screen.getByText(/^1 finding •/).textContent).not.toContain("user");
  expect(getAdminPiiTop).toHaveBeenLastCalledWith({ range: "7d", groupBy: "session" });
});

it.each([
  ["Users", "No users with findings in this range."],
  ["Sessions", "No sessions with findings in this range."]
])("says when no %s have findings", async (tab, message) => {
  renderTop([], []);
  await screen.findByText("No users with findings in this range.");

  fireEvent.click(screen.getByRole("tab", { name: tab }));

  expect(await screen.findByText(message)).toBeTruthy();
});
