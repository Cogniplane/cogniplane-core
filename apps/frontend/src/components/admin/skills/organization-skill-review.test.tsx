// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSkillSubmissionDetail } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { previewAdminSkillRelease } from "@/lib/admin-api";
import { decideSkillSubmission, getAdminSkillSubmission, listAdminSkillSubmissions, releaseSkillSubmission } from "@/lib/organization-skill-submissions-api";
import { OrganizationSkillReview } from "./organization-skill-review";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
vi.mock("@/lib/organization-skill-submissions-api", () => ({
  decideSkillSubmission: vi.fn(), getAdminSkillSubmission: vi.fn(), listAdminSkillSubmissions: vi.fn(), releaseSkillSubmission: vi.fn()
}));
vi.mock("@/lib/admin-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/admin-api")>()), previewAdminSkillRelease: vi.fn() }));
const scope = { tenantId: "tenant-a", userId: "admin-a" };
const content = { name: "meeting-notes", description: "Prepare useful notes", instructions: "## Steps\nWrite decisions." };
const initial: OrganizationSkillSubmissionDetail = {
  id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", version: 1, status: "pending", authorUserId: "author-a",
  authorName: "Alex Morgan", authorEmail: "alex@example.test", sourceSkillId: "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  targetOrganizationSkillId: null, acceptedOrganizationSkillId: null,
  latest: { attempt: 1, status: "pending", note: "This saves meeting time", snapshot: { content, sourceRevision: 2, contentHash: "a".repeat(64), validationMessages: [] },
    submittedAt: "2026-09-22T12:00:00Z", decidedAt: null, decidedBy: null, decidedByName: null, feedback: null, acceptedRevisionId: null },
  attempts: [], updates: [], organizationSkill: null, createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z"
};
const accepted: OrganizationSkillSubmissionDetail = {
  ...initial, version: 2, status: "accepted", acceptedOrganizationSkillId: "meeting-notes",
  latest: { ...initial.latest, status: "accepted", acceptedRevisionId: 7 },
  organizationSkill: { skillId: "meeting-notes", version: 1, enabled: false, isPublished: false,
    activeRevisionId: null, currentDraftRevisionId: 7, activeContent: null, currentDraftContent: content }
};
const releaseSnapshot = { version: 1, activeRevisionId: null, latestRevisionId: 7, enabled: false, isPublished: false };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(previewAdminSkillRelease).mockResolvedValue({ skillId: "meeting-notes", snapshot: releaseSnapshot,
    current: { revisionId: null, revisionNumber: null, audience: "off" }, proposed: { revisionId: 7, revisionNumber: 1, audience: "members" },
    members: { total: 8, testUsers: 2, gaining: 8, losing: 0 },
    configuredReferences: { projects: { inherited: 1, explicitSelected: 2 },
      personalDefaults: { inherited: 3, explicitSelected: 4 }, sessions: { inherited: 5, explicitSelected: 6 } } });
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [initial] });
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: initial });
  vi.mocked(decideSkillSubmission).mockResolvedValue({ scope, submission: accepted });
  vi.mocked(releaseSkillSubmission).mockResolvedValue({ scope, submission: {
    ...accepted, organizationSkill: { ...accepted.organizationSkill!, version: 2, enabled: true, activeRevisionId: 7, isPublished: true }
  } });
});
afterEach(cleanup);

it("decides the initially selected item and releases its exact draft with an explicit audience", async () => {
  const onQueueChanged = vi.fn();
  vi.mocked(decideSkillSubmission).mockImplementation(async () => { vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: accepted }); return { scope, submission: accepted }; });
  render(<OrganizationSkillReview onQueueChanged={onQueueChanged} />);
  expect(await screen.findByRole("button", { name: "Accept as draft" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept as draft" }));
  await waitFor(() => expect(decideSkillSubmission).toHaveBeenCalledWith(initial.id, {
    scope, version: 1, action: "accept", reason: null, organizationSkillId: "meeting-notes",
    organizationSkillName: "meeting-notes", expectedOrganizationVersion: null
  }));
  expect(await screen.findByText(/Accepted as an organization draft/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /All members/ }));
  fireEvent.click(screen.getByRole("button", { name: "Preview release to all members" }));
  expect(releaseSkillSubmission).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release to all members" }));
  await waitFor(() => expect(releaseSkillSubmission).toHaveBeenCalledWith(initial.id, {
    scope, expectedOrganizationVersion: 1, expectedActiveRevisionId: null, expectedDraftRevisionId: 7,
    audience: "members", expectedSnapshot: releaseSnapshot
  }));
  expect(onQueueChanged).toHaveBeenCalled();
});

it("keeps feedback when a decision fails or the admin switches actions", async () => {
  vi.mocked(decideSkillSubmission).mockRejectedValue(new ApiError({ status: 409, code: "submission_conflict", method: "POST", path: "/admin/skill-submissions/x/decision", message: "Review changed" }));
  render(<OrganizationSkillReview />);
  fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
  fireEvent.change(screen.getByLabelText("What should the author change?"), { target: { value: "Add one example" } });
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect((screen.getByLabelText("What should the author change?") as HTMLTextAreaElement).value).toBe("Add one example");
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(decideSkillSubmission).toHaveBeenCalled());
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Review changed"));
  expect((screen.getByLabelText("What should the author change?") as HTMLTextAreaElement).value).toBe("Add one example");
});

it("separates waiting records from completed records and supports queue search and back navigation", async () => {
  const waiting = { ...initial, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc", status: "changes_requested" as const,
    latest: { ...initial.latest, status: "changes_requested" as const, snapshot: { ...initial.latest.snapshot, content: { ...content, name: "action-planner" } } } };
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [initial, waiting] });
  vi.mocked(getAdminSkillSubmission).mockImplementation(async (id) => ({ scope, submission: id === waiting.id ? { ...waiting, attempts: [], organizationSkill: null } : initial }));
  render(<OrganizationSkillReview />);
  await screen.findByRole("button", { name: /meeting-notes/ });
  fireEvent.click(screen.getByRole("button", { name: "Waiting" }));
  expect(screen.getByRole("button", { name: /action-planner/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /meeting-notes.*New/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "all" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search submissions" }), { target: { value: "Alex" } });
  expect(screen.getByRole("button", { name: /action-planner/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /action-planner/ }));
  fireEvent.click(screen.getByRole("button", { name: /Back to queue/ }));
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-current")).toBe("true"));
});

it("clears the queue on a mismatched scope response", async () => {
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope: { ...scope, tenantId: "tenant-b" }, submissions: [initial] });
  render(<OrganizationSkillReview />);
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByText("meeting-notes")).toBeNull();
});

it("retries a failed detail request without leaving the detail pane loading", async () => {
  vi.mocked(getAdminSkillSubmission).mockRejectedValueOnce(new Error("Detail unavailable"));
  render(<OrganizationSkillReview />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Detail unavailable"));
  expect(screen.queryByRole("button", { name: "Accept as draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  expect(await screen.findByRole("button", { name: "Accept as draft" })).toBeTruthy();
  expect(getAdminSkillSubmission).toHaveBeenCalledTimes(2);
});

it("hides the old detail while a filter selects another submission", async () => {
  const waiting = { ...initial, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc", status: "changes_requested" as const,
    latest: { ...initial.latest, status: "changes_requested" as const, snapshot: { ...initial.latest.snapshot,
      content: { ...content, name: "action-planner" } } } };
  let resolveWaiting!: (result: { scope: typeof scope; submission: typeof waiting }) => void;
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [initial, waiting] });
  vi.mocked(getAdminSkillSubmission).mockImplementation((id) => id === waiting.id
    ? new Promise((resolve) => { resolveWaiting = resolve; })
    : Promise.resolve({ scope, submission: initial }));
  render(<OrganizationSkillReview />);
  const detailPane = screen.getByLabelText("Skill review detail");
  await within(detailPane).findAllByRole("heading", { name: "meeting-notes" });
  fireEvent.click(screen.getByRole("button", { name: "Waiting" }));
  expect(within(detailPane).queryAllByRole("heading", { name: "meeting-notes" })).toHaveLength(0);
  resolveWaiting({ scope, submission: waiting });
  expect(await within(detailPane).findAllByRole("heading", { name: "action-planner" })).toHaveLength(2);
});

it("shows a detail response newer than the queue snapshot", async () => {
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: { ...initial, version: 2 } });
  render(<OrganizationSkillReview />);
  expect(await within(screen.getByLabelText("Skill review detail")).findAllByRole("heading", { name: "meeting-notes" })).toHaveLength(2);
});

it("keeps the accepted fallback selected when returning to all submissions", async () => {
  const waiting: OrganizationSkillSubmissionDetail = {
    ...initial, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc", status: "changes_requested",
    latest: { ...initial.latest, status: "changes_requested", snapshot: { ...initial.latest.snapshot,
      content: { ...content, name: "action-planner" } } }
  };
  let pendingDetail: OrganizationSkillSubmissionDetail = initial;
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [waiting, initial] });
  vi.mocked(getAdminSkillSubmission).mockImplementation(async (id) => ({ scope,
    submission: id === waiting.id ? waiting : pendingDetail }));
  vi.mocked(decideSkillSubmission).mockImplementation(async () => {
    pendingDetail = accepted;
    return { scope, submission: accepted };
  });
  render(<OrganizationSkillReview />);
  fireEvent.click(await screen.findByRole("button", { name: "all" }));
  fireEvent.click(screen.getByRole("button", { name: /action-planner/ }));
  await within(screen.getByLabelText("Skill review detail")).findAllByRole("heading", { name: "action-planner" });
  fireEvent.click(screen.getByRole("button", { name: "Needs review" }));
  expect(await screen.findByRole("button", { name: "Accept as draft" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept as draft" }));
  expect(await screen.findByText(/Accepted as an organization draft/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Preview release to test users" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /meeting-notes/ }).getAttribute("aria-current")).toBe("true");
});

it("hides decision actions while a newer queue version loads", async () => {
  const newer = { ...initial, version: 2 };
  vi.mocked(listAdminSkillSubmissions)
    .mockResolvedValueOnce({ scope, submissions: [initial] })
    .mockResolvedValue({ scope, submissions: [newer] });
  vi.mocked(getAdminSkillSubmission)
    .mockResolvedValueOnce({ scope, submission: initial })
    .mockImplementation(() => new Promise(() => {}));
  vi.mocked(decideSkillSubmission).mockRejectedValue(new Error("Review changed"));
  render(<OrganizationSkillReview />);
  fireEvent.click(await screen.findByRole("button", { name: "Accept as draft" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Accept as draft" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  expect(decideSkillSubmission).toHaveBeenCalledTimes(1);
});

it("opens a linked completed submission on mobile without selecting the pending fallback", async () => {
  const completed = { ...accepted, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    latest: { ...accepted.latest, snapshot: { ...accepted.latest.snapshot, content: { ...content, name: "completed-notes" } } } };
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [initial, completed] });
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: completed });
  render(<OrganizationSkillReview requestedSubmissionId={completed.id} />);
  const detailPane = screen.getByLabelText("Skill review detail");
  expect(await within(detailPane).findAllByRole("heading", { name: "completed-notes" })).toHaveLength(2);
  expect(detailPane.className).toContain("flex");
  expect(screen.getByRole("button", { name: /completed-notes/ }).getAttribute("aria-current")).toBe("true");
  expect(getAdminSkillSubmission).toHaveBeenCalledWith(completed.id);
  expect(decideSkillSubmission).not.toHaveBeenCalled();
});

it("shows a missing linked submission and never fetches or decides the first queue item", async () => {
  render(<OrganizationSkillReview requestedSubmissionId="missing-id" />);
  expect(await screen.findByText(/no longer in the review queue/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept as draft" })).toBeNull();
  expect(getAdminSkillSubmission).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /meeting-notes/ }));
  expect(await screen.findByRole("button", { name: "Accept as draft" })).toBeTruthy();
  expect(getAdminSkillSubmission).toHaveBeenCalledWith(initial.id);
});

it("reports a successful decision after the admin selects another submission", async () => {
  const second = { ...initial, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    latest: { ...initial.latest, snapshot: { ...initial.latest.snapshot, content: { ...content, name: "action-planner" } } } };
  let finishDecision!: (result: { scope: typeof scope; submission: OrganizationSkillSubmissionDetail }) => void;
  const onQueueChanged = vi.fn();
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [initial, second] });
  vi.mocked(getAdminSkillSubmission).mockImplementation(async (id) => ({ scope, submission: id === second.id ? second : initial }));
  vi.mocked(decideSkillSubmission).mockImplementation(() => new Promise((resolve) => { finishDecision = resolve; }));
  render(<OrganizationSkillReview onQueueChanged={onQueueChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Accept as draft" }));
  fireEvent.click(screen.getByRole("button", { name: /action-planner/ }));
  finishDecision({ scope, submission: accepted });
  await waitFor(() => expect(onQueueChanged).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: /action-planner/ }).getAttribute("aria-current")).toBe("true");
});

const updateContent = { name: "meeting-notes", description: "Prepare useful notes", instructions: "## Steps\n\nWrite decisions." };
function updateSubmission(activeContent: typeof content | null): OrganizationSkillSubmissionDetail {
  return {
    ...initial, targetOrganizationSkillId: "meeting-notes",
    latest: { ...initial.latest, snapshot: { ...initial.latest.snapshot, content: updateContent } },
    organizationSkill: { skillId: "meeting-notes", version: 3, enabled: true, isPublished: true,
      activeRevisionId: 5, currentDraftRevisionId: 5, activeContent, currentDraftContent: activeContent }
  };
}

it("shows an update's changes line by line against the active organization version", async () => {
  const update = updateSubmission({ ...updateContent, description: "Old description" });
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [update] });
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: update });
  const { container } = render(<OrganizationSkillReview />);

  fireEvent.click(await screen.findByRole("button", { name: "Changes" }));

  const rows = Array.from(container.querySelectorAll<HTMLDivElement>("div.font-mono"));
  // Text with the given parts removed: aria-hidden parts for a screen reader, sr-only parts for the eye.
  const textWithout = (row: HTMLElement, selector: string) => {
    const copy = row.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(selector).forEach((part) => part.remove());
    return copy.textContent;
  };
  // A screen reader hears whether each line was added or removed, not only its colour.
  expect(rows.map((row) => textWithout(row, '[aria-hidden="true"]'))).toEqual([
    "meeting-notes", "Removed: Old description", "Added: Prepare useful notes", "## Steps", " ", "Write decisions."
  ]);
  // On screen, each row is its marker followed by the line; a blank line keeps a space so the row has height.
  expect(rows.map((row) => textWithout(row, ".sr-only"))).toEqual([
    " meeting-notes", "−Old description", "+Prepare useful notes", " ## Steps", "  ", " Write decisions."
  ]);
});

it("says there is nothing to compare when the update has no active organization version", async () => {
  const update = updateSubmission(null);
  vi.mocked(listAdminSkillSubmissions).mockResolvedValue({ scope, submissions: [update] });
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope, submission: update });
  render(<OrganizationSkillReview />);

  fireEvent.click(await screen.findByRole("button", { name: "Changes" }));

  expect(screen.getByText("No current organization version is available for comparison.")).toBeTruthy();
});
