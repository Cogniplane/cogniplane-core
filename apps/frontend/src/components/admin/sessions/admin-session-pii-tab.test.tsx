// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AdminSessionPiiTab } from "./admin-session-pii-tab";
afterEach(cleanup);
it("identifies instruction scans by project and revision separately from messages", () => {
  const common = { scanRunId: "scan", subjectId: "project-123", sourceUserId: "user", mode: "block", status: "blocked",
    providerType: null, providerModel: null, findings: [], summaryText: null, actionTaken: "block", errorMessage: null,
    createdAt: "2026-09-14T00:00:00Z", completedAt: null };
  render(<AdminSessionPiiTab piiRuns={[
    { ...common, subjectType: "project_instructions", instructionsRevision: 7 },
    { ...common, scanRunId: "message-scan", subjectType: "message", subjectId: "session-123" }
  ]} />);
  expect(screen.getByText(/Project instructions.*Revision 7/)).toBeTruthy();
  expect(screen.getByText(/^Message /)).toBeTruthy();
});
