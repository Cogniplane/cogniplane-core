// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSkillSubmissionDetail, PersonalSkill } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import {
  getMySkillSubmission, listMySkillSubmissions, resubmitSkillSubmission,
  submitPersonalSkill, withdrawSkillSubmission
} from "@/lib/organization-skill-submissions-api";
import { OrganizationSkillSubmissions } from "./organization-skill-submissions";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

vi.mock("@/lib/organization-skill-submissions-api", () => ({
  getMySkillSubmission: vi.fn(), listMySkillSubmissions: vi.fn(), resubmitSkillSubmission: vi.fn(),
  submitPersonalSkill: vi.fn(), withdrawSkillSubmission: vi.fn()
}));
const scope = { tenantId: "tenant-a", userId: "author-a" };
const skillId = "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const active = { revision: 1, content: { name: "meeting-notes", description: "Prepare notes", instructions: "Old instructions" }, validationMessages: [], createdAt: "2026-09-20T12:00:00Z" };
const latest = { revision: 2, content: { ...active.content, instructions: "New instructions" }, validationMessages: [], createdAt: "2026-09-21T12:00:00Z" };
const skill: PersonalSkill = { id: skillId, version: 2, enabled: true, active, latest, updatedAt: latest.createdAt };
const submission = (status: OrganizationSkillSubmissionDetail["status"]): OrganizationSkillSubmissionDetail => ({
  id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", version: 2, status, authorUserId: scope.userId,
  authorName: "Alex Morgan", authorEmail: "alex@example.test", sourceSkillId: skillId,
  targetOrganizationSkillId: null, acceptedOrganizationSkillId: status === "accepted" ? "meeting-notes" : null,
  latest: { attempt: 1, status, note: "Please review", snapshot: { content: latest.content, sourceRevision: 2, contentHash: "a".repeat(64), validationMessages: [] },
    submittedAt: "2026-09-22T12:00:00Z", decidedAt: null, decidedBy: null, decidedByName: null, feedback: status === "changes_requested" ? "Add an example" : null, acceptedRevisionId: null },
  attempts: [], updates: [], organizationSkill: null, createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z"
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [] });
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: submission("pending") });
  vi.mocked(submitPersonalSkill).mockResolvedValue({ scope, submission: submission("pending") });
  vi.mocked(withdrawSkillSubmission).mockResolvedValue({ scope, submission: submission("withdrawn") });
  vi.mocked(resubmitSkillSubmission).mockResolvedValue({ scope, submission: submission("pending") });
});
afterEach(cleanup);

it("submits exactly the selected saved revision and previews the shared text", async () => {
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={skillId} onBack={vi.fn()} />);
  expect(await screen.findByText("New instructions")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Saved revision to share"), { target: { value: "1" } });
  expect(await screen.findByText("Old instructions")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Note to reviewers"), { target: { value: "Please use the active version" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  await waitFor(() => expect(submitPersonalSkill).toHaveBeenCalledWith({
    scope, personalSkillId: skillId, sourceRevision: 1, note: "Please use the active version", targetOrganizationSkillId: null
  }));
});

it("keeps retained history after source deletion and allows withdrawal while changes are requested", async () => {
  const waiting = submission("changes_requested");
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [waiting] });
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: waiting });
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[]} initialSkillId={null} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /meeting-notes/ }));
  expect(await screen.findByText(/original private skill no longer exists/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revise and resubmit" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw submission" }));
  await waitFor(() => expect(withdrawSkillSubmission).toHaveBeenCalledWith(waiting.id, { scope, version: waiting.version }));
});

it("locks the source skill on resubmission and retains the note after a conflict", async () => {
  const waiting = submission("changes_requested");
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [waiting] });
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: waiting });
  vi.mocked(resubmitSkillSubmission).mockRejectedValue(new ApiError({ status: 409, code: "submission_conflict", method: "POST", path: "/me/skill-submissions/x/resubmit", message: "Review changed" }));
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /meeting-notes/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));
  expect((screen.getByLabelText("Private skill") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Note to reviewers"), { target: { value: "Added an example" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit revised copy" }));
  await waitFor(() => expect(resubmitSkillSubmission).toHaveBeenCalledWith(waiting.id, {
    scope, version: waiting.version, sourceRevision: 2, note: "Added an example"
  }));
  expect((screen.getByLabelText("Note to reviewers") as HTMLTextAreaElement).value).toBe("Added an example");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Review changed"));
  expect((screen.getByRole("button", { name: "Submit revised copy" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: { ...waiting, version: 3 } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh submission state" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Submit revised copy" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Note to reviewers") as HTMLTextAreaElement).value).toBe("Added an example");
});

it("refreshes a new submission conflict without losing the note", async () => {
  vi.mocked(submitPersonalSkill).mockRejectedValueOnce(new ApiError({ status: 409, code: "submission_conflict", method: "POST", path: "/me/skill-submissions", message: "Review changed" }));
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={skillId} onBack={vi.fn()} />);
  await waitFor(() => expect(listMySkillSubmissions).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Note to reviewers"), { target: { value: "Keep this review note" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh submission state" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Note to reviewers") as HTMLTextAreaElement).value).toBe("Keep this review note");
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  await waitFor(() => expect(submitPersonalSkill).toHaveBeenCalledTimes(2));
});

it("clears private data on a mismatched response scope", async () => {
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope: { ...scope, userId: "other" }, submissions: [submission("pending")] });
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null} onBack={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByText("Review history")).toBeNull();
});

it("opens the exact linked submission when the URL target changes on the same page", async () => {
  const first = submission("pending");
  const second = { ...submission("accepted"), id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    latest: { ...submission("accepted").latest, snapshot: { ...submission("accepted").latest.snapshot,
      content: { ...latest.content, name: "changed-skill" } } } };
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [first, second] });
  vi.mocked(getMySkillSubmission).mockImplementation(async (id) => ({ scope, submission: id === second.id ? second : first }));
  const view = render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={first.id} onBack={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "meeting-notes" })).toBeTruthy();
  view.rerender(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={second.id} onBack={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "changed-skill" })).toBeTruthy();
  expect(getMySkillSubmission).toHaveBeenLastCalledWith(second.id);
});

it("shows a missing linked submission without selecting another item", async () => {
  const missingId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [submission("pending")] });
  vi.mocked(getMySkillSubmission).mockRejectedValue(new ApiError({ status: 404, code: "not_found", method: "GET",
    path: `/me/skill-submissions/${missingId}`, message: "Submission not found" }));
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={missingId} onBack={vi.fn()} />);
  expect(await screen.findByText(/This submission is not available/)).toBeTruthy();
  expect(getMySkillSubmission).toHaveBeenCalledTimes(1);
  expect(getMySkillSubmission).toHaveBeenCalledWith(missingId);
});

it("clears a linked submission before returning to private skills", async () => {
  const linked = submission("pending");
  const onBack = vi.fn();
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={linked.id} onBack={onBack} />);
  fireEvent.click(screen.getByRole("button", { name: "Back to private skills" }));
  expect(navigation.replace).toHaveBeenCalledWith("/settings/capabilities");
  expect(onBack).toHaveBeenCalledOnce();
});

it("shows dated release history without claiming the revision is currently available", async () => {
  const accepted = { ...submission("accepted"), updates: [{
    id: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee", submissionId: submission("accepted").id, attempt: 1,
    kind: "released" as const, skillName: "meeting-notes", feedback: null, organizationSkillId: "meeting-notes",
    organizationRevisionId: 7, audience: "test-users" as const, createdAt: "2026-09-25T12:00:00Z", readAt: null
  }] };
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: accepted });
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={accepted.id} onBack={vi.fn()} />);
  expect(await screen.findByText(/Released revision 7 to test users/)).toHaveProperty("textContent", expect.stringContaining("Later releases may have changed"));
  expect(screen.getByText(/See the dated release history/)).toBeTruthy();
});

it("keeps the list that loads while a linked submission opens and warns about an open submission", async () => {
  const accepted = submission("accepted");
  const open = { ...submission("pending"), id: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
  let finishList!: (value: { scope: typeof scope; submissions: OrganizationSkillSubmissionDetail[] }) => void;
  vi.mocked(listMySkillSubmissions).mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
  vi.mocked(getMySkillSubmission).mockResolvedValue({ scope, submission: accepted });
  render(<OrganizationSkillSubmissions expectedScope={scope} skills={[skill]} initialSkillId={null}
    requestedSubmissionId={accepted.id} onBack={vi.fn()} />);
  // The detail opens before the list response lands.
  fireEvent.click(await screen.findByRole("button", { name: "Submit update" }));
  finishList({ scope, submissions: [accepted, open] });
  expect(await screen.findByText(/already has an open submission/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Submit update" }) as HTMLButtonElement).disabled).toBe(true);
});
