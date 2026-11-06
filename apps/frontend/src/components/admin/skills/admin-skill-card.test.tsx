// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSkill, SkillImportResponse, SkillRevision } from "@cogniplane/shared-types";
import { getAdminSkillSubmission } from "@/lib/organization-skill-submissions-api";
import { acceptedSkillDraft, verifyAcceptedSkillDraft } from "./accepted-skill-draft";
import type { OrganizationSkillSubmissionDetail } from "@cogniplane/shared-types";
import { previewAdminSkillRelease } from "@/lib/admin-api";

import { AdminSkillCard } from "./admin-skill-card";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
vi.mock("@/lib/admin-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/admin-api")>()), previewAdminSkillRelease: vi.fn() }));

vi.mock("@/lib/organization-skill-submissions-api", () => ({ getAdminSkillSubmission: vi.fn() }));

afterEach(cleanup);

const skill = {
  skillId: "briefing",
  skillName: "Briefing",
  description: "Write a briefing",
  instructions: "",
  version: 0,
  contentHash: "",
  enabled: false,
  isPublished: false,
  createdBy: "admin",
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  activeRevisionId: null,
  activeSourceType: null,
  activeBundleName: null,
  activeBundleStorageUri: null,
  activeBundleHash: null,
  activeValidationStatus: null,
  activeReviewStatus: null,
  isInherited: false,
  pendingRevisionCount: 1
} satisfies AdminSkill;

const revision = {
  skillRevisionId: 12,
  skillId: "briefing",
  revisionNumber: 1,
  sourceType: "inline",
  sourceLabel: null,
  bundleName: null,
  bundleStorageUri: null,
  bundleHash: "abc123",
  validationStatus: "validated",
  validationMessages: [],
  reviewStatus: "pending_review",
  reviewNotes: null,
  metadata: { instructions: "Write a concise briefing.", allowedTools: ["web_search"] },
  createdBy: "admin",
  createdAt: "2026-09-26T00:00:00Z",
  reviewedBy: null,
  reviewedAt: null,
  activatedAt: null
} satisfies SkillRevision;
const snapshot = { version: 0, activeRevisionId: null, latestRevisionId: 12, enabled: false, isPublished: false };

vi.mocked(previewAdminSkillRelease).mockResolvedValue({ skillId: "briefing", snapshot,
  current: { revisionId: null, revisionNumber: null, audience: "off" }, proposed: { revisionId: 12, revisionNumber: 1, audience: "members" },
  members: { total: 12, testUsers: 2, gaining: 12, losing: 0 },
  configuredReferences: { projects: { inherited: 1, explicitSelected: 2 },
    personalDefaults: { inherited: 3, explicitSelected: 4 }, sessions: { inherited: 5, explicitSelected: 6 } } });

function renderCard(overrides: Partial<Parameters<typeof AdminSkillCard>[0]> = {}) {
  const onImportInline = vi.fn(async (): Promise<SkillImportResponse> => ({ skill, revision }));
  const onActivateRevision = vi.fn(async () => undefined);
  const onPublish = vi.fn(async () => ({ ...skill, enabled: true, isPublished: true }));
  const onUnpublish = vi.fn(async () => skill);
  const props: Parameters<typeof AdminSkillCard>[0] = {
    skills: [],
    marketplace: null,
    manifestUrl: null,
    busyKey: null,
    onDisable: async () => skill,
    onPublish,
    onUnpublish,
    onImportZip: async () => ({ skill, revision }),
    onImportGithub: async () => ({ skill, revision }),
    onImportInline,
    onImportMarketplace: async () => ({ skill, revision }),
    onListRevisions: async () => [revision],
    onActivateRevision,
    onSaveManifestUrl: async () => undefined,
    ...overrides
  };
  const view = render(<AdminSkillCard {...props} />);
  return { onImportInline, onActivateRevision, onPublish, onUnpublish, unmount: view.unmount,
    replaceScope: () => view.rerender(<AdminSkillCard key="another-scope" {...props} acceptedDraft={null} />),
    rerenderWithSkill: (next: AdminSkill) => view.rerender(<AdminSkillCard {...props} skills={[next]} />),
    rerender: (next: Partial<Parameters<typeof AdminSkillCard>[0]>) => view.rerender(<AdminSkillCard {...props} {...next} />) };
}

it("opens imported skill for review and releases it only to the chosen audience", async () => {
  const { onActivateRevision, onPublish, onUnpublish } = renderCard();
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  await screen.findByLabelText("Skill ID");
  fireEvent.change(screen.getByLabelText("Skill ID"), { target: { value: "briefing" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Briefing" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Write a briefing" } });
  fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Write a concise briefing." } });
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

  fireEvent.click(await screen.findByRole("button", { name: "Review saved draft" }));
  await waitFor(() => expect(screen.getByText("Review this new draft before release.")).toBeTruthy());
  expect(screen.getByText("Write a concise briefing.")).toBeTruthy();
  expect(screen.getByText("Declared tools: web_search")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Choose an audience to preview" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "All members" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview release" }));
  expect(onActivateRevision).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(onActivateRevision).toHaveBeenCalledWith({ skillId: "briefing", skillRevisionId: 12, reviewNotes: null, audience: "members", expectedSnapshot: snapshot }));
  expect(onActivateRevision).toHaveBeenCalledTimes(1);
  expect(onPublish).not.toHaveBeenCalled();
  expect(onUnpublish).not.toHaveBeenCalled();
});

it("offers a re-enable path for the active revision", async () => {
  const disabled = { ...skill, activeRevisionId: 12, pendingRevisionCount: 0 };
  const { onActivateRevision } = renderCard({ skills: [disabled] });
  fireEvent.click(screen.getByRole("button", { name: "Re-enable" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose an audience to preview" })).toBeTruthy());
  expect(screen.getByRole("radio", { name: "Test users" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Choose an audience to preview" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Test users" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview re-enable" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm re-enable" }));
  await waitFor(() => expect(onActivateRevision).toHaveBeenCalledWith({ skillId: "briefing", skillRevisionId: 12, reviewNotes: null, audience: "test-users", expectedSnapshot: snapshot }));
});

it("closes an already-saved revision without activating it", async () => {
  const { onActivateRevision } = renderCard({ skills: [skill] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Close review" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Choose an audience to preview" })).toBeNull());
  expect(screen.getByText("1 update to review")).toBeTruthy();
  expect(onActivateRevision).not.toHaveBeenCalled();
});

it("keeps the chosen audience after a failed atomic release and retries it", async () => {
  const onUnpublish = vi.fn(async () => skill);
  const onActivateRevision = vi.fn()
    .mockRejectedValueOnce(new Error("Release request failed"))
    .mockResolvedValueOnce(undefined);
  const onPublish = vi.fn(async () => skill);
  const liveSkill = { ...skill, enabled: true, isPublished: true, activeRevisionId: 11 };
  const { rerenderWithSkill } = renderCard({ skills: [liveSkill], onUnpublish, onActivateRevision, onPublish });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  await screen.findByRole("button", { name: "Choose an audience to preview" });
  fireEvent.click(screen.getByRole("radio", { name: "All members" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview release" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Release request failed"));
  rerenderWithSkill(liveSkill);
  expect(screen.getByText("Available to members")).toBeTruthy();
  expect((screen.getByRole("radio", { name: "All members" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh impact" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(onActivateRevision).toHaveBeenCalledTimes(2));
  expect(onActivateRevision).toHaveBeenNthCalledWith(1, { skillId: "briefing", skillRevisionId: 12, reviewNotes: null, audience: "members", expectedSnapshot: snapshot });
  expect(onActivateRevision).toHaveBeenNthCalledWith(2, { skillId: "briefing", skillRevisionId: 12, reviewNotes: null, audience: "members", expectedSnapshot: snapshot });
  expect(onUnpublish).not.toHaveBeenCalled();
  expect(onPublish).not.toHaveBeenCalled();
});

it("keeps inherited skill history readable without tenant mutation actions", async () => {
  const onDisable = vi.fn(async () => skill);
  const onPublish = vi.fn(async () => skill);
  const onUnpublish = vi.fn(async () => skill);
  const onActivateRevision = vi.fn(async () => undefined);
  renderCard({
    skills: [{ ...skill, isInherited: true, enabled: false, isPublished: true, activeRevisionId: 12 }],
    onDisable,
    onPublish,
    onUnpublish,
    onActivateRevision
  });

  expect(screen.getAllByText(/Managed by the platform/).length).toBeGreaterThan(0);
  expect(screen.queryByText("1 update to review")).toBeNull();
  expect(screen.queryByRole("button", { name: "Limit to test users" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Re-enable" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  await waitFor(() => expect(screen.getByText("Write a concise briefing.")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Re-enable skill" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview release" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Close review" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Review notes" })).toBeNull();
  expect(onDisable).not.toHaveBeenCalled();
  expect(onPublish).not.toHaveBeenCalled();
  expect(onUnpublish).not.toHaveBeenCalled();
  expect(onActivateRevision).not.toHaveBeenCalled();
});

it("brings a targeted skill into focus and opens its history without changing it", async () => {
  const other = { ...skill, skillId: "notes", skillName: "Notes" };
  const onListRevisions = vi.fn(async (skillId: string) => [{ ...revision, skillId }]);
  const { onActivateRevision, onPublish, onUnpublish } = renderCard({ skills: [other, skill], onListRevisions, targetSkillId: "briefing" });
  const card = screen.getByText("Selected").closest("[aria-current]") as HTMLElement;
  expect(card.textContent).toContain("Briefing");
  expect(document.activeElement).toBe(card);
  await waitFor(() => expect(onListRevisions).toHaveBeenCalledWith("briefing"));
  expect(await screen.findByRole("button", { name: "Hide history" })).toBeTruthy();
  expect(onListRevisions).toHaveBeenCalledTimes(1);
  expect(onActivateRevision).not.toHaveBeenCalled();
  expect(onPublish).not.toHaveBeenCalled();
  expect(onUnpublish).not.toHaveBeenCalled();
});

it("keeps unsaved review notes on another skill when a new target arrives", async () => {
  const other = { ...skill, skillId: "notes", skillName: "Notes" };
  const onListRevisions = vi.fn(async (skillId: string) => [{ ...revision, skillId }]);
  const { rerender } = renderCard({ skills: [other, skill], onListRevisions });
  fireEvent.click(screen.getAllByRole("button", { name: "Review and history" })[0]);
  const notes = await screen.findByLabelText("Review notes") as HTMLTextAreaElement;
  fireEvent.change(notes, { target: { value: "Check the sources first" } });

  rerender({ targetSkillId: "briefing" });
  expect(screen.getByText("Selected")).toBeTruthy();
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("Check the sources first");
  expect(onListRevisions).not.toHaveBeenCalledWith("briefing");
});

it("opens the editor with the active inline revision's text and saves it as a new revision", async () => {
  const active = { ...revision, reviewStatus: "active", activatedAt: "2026-09-26T00:00:00Z",
    metadata: { skillName: "Briefing", description: "Write a briefing", instructions: "Write a concise briefing." } };
  const older = { ...revision, skillRevisionId: 11, revisionNumber: 0, reviewStatus: "superseded",
    metadata: { skillName: "Old name", description: "Old purpose", instructions: "Old text." } };
  const enabled = { ...skill, enabled: true, activeRevisionId: 12, pendingRevisionCount: 0 };
  const { onImportInline } = renderCard({ skills: [enabled], onListRevisions: async () => [active, older] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));

  // Only the active revision can be edited.
  await screen.findByRole("button", { name: "Edit" });
  expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((within(screen.getByRole("dialog")).getByLabelText("Display name") as HTMLInputElement).value).toBe("Briefing");
  expect((within(screen.getByRole("dialog")).getByLabelText("Description") as HTMLInputElement).value).toBe("Write a briefing");
  fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Write a short briefing." } });
  fireEvent.click(screen.getByRole("button", { name: "Save as new revision" }));

  await waitFor(() => expect(onImportInline).toHaveBeenCalledWith({
    skillId: "briefing", skillName: "Briefing", description: "Write a briefing", instructions: "Write a short briefing."
  }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("opens the editor empty for fields that the revision metadata does not hold as text", async () => {
  const active = { ...revision, reviewStatus: "active", activatedAt: "2026-09-26T00:00:00Z",
    metadata: { skillName: 7, instructions: "Keep this." } };
  renderCard({ skills: [{ ...skill, enabled: true, activeRevisionId: 12, pendingRevisionCount: 0 }], onListRevisions: async () => [active] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));

  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

  expect((within(screen.getByRole("dialog")).getByLabelText("Display name") as HTMLInputElement).value).toBe("");
  expect((within(screen.getByRole("dialog")).getByLabelText("Description") as HTMLInputElement).value).toBe("");
  expect((within(screen.getByRole("dialog")).getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe("Keep this.");
});

it("retains unsent notes through close, skill switches, refresh and re-enable open", async () => {
  const other = { ...skill, skillId: "notes", skillName: "Notes", activeRevisionId: 13 };
  renderCard({ skills: [skill, other], onListRevisions: async id => [{ ...revision, skillId: id, skillRevisionId: id === "briefing" ? 12 : 13 }] });
  fireEvent.click(screen.getAllByRole("button", { name: "Review and history" })[0]);
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "A notes stay with revision 12" } });
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  expect(screen.queryByLabelText("Review notes")).toBeNull();
  expect(screen.getByText("Briefing, r1, revision #12")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Review and history" })[1]);
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "B notes stay with revision 13" } });
  fireEvent.click(screen.getByRole("button", { name: "Re-enable" }));
  fireEvent.click(await screen.findByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("B notes stay with revision 13"));
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("A notes stay with revision 12");
});

it("requires an explicit discard decision for the named revision and restores saved notes", async () => {
  renderCard({ skills: [skill], onListRevisions: async () => [{ ...revision, reviewNotes: "Saved review evidence" }] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "Unsent replacement" } });
  fireEvent.click(screen.getByRole("button", { name: /Discard unsent notes for Briefing, revision #12/ }));
  expect(screen.getByRole("alertdialog").textContent).toContain("Briefing, r1, revision #12");
  fireEvent.click(screen.getByRole("button", { name: "Keep notes" }));
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("Unsent replacement");
  fireEvent.click(screen.getByRole("button", { name: /Discard unsent notes for Briefing, revision #12/ }));
  fireEvent.click(screen.getByRole("button", { name: "Discard notes" }));
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("Saved review evidence");
  expect(screen.queryByRole("button", { name: /Discard unsent notes/ })).toBeNull();
});

it("keeps revision-specific notes until the explicit saved-draft handoff opens a different revision", async () => {
  const nextRevision = { ...revision, skillRevisionId: 14, revisionNumber: 2 };
  let rows = [revision];
  const onImportInline = vi.fn(async () => { rows = [nextRevision, revision]; return { skill, revision: nextRevision }; });
  renderCard({ skills: [skill], onListRevisions: async () => rows, onImportInline });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "Only revision 12" } });
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  fireEvent.change(screen.getByLabelText("Skill ID"), { target: { value: "briefing" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Briefing" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Write a briefing" } });
  fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), { target: { value: "New immutable text" } });
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review saved draft" }));
  await waitFor(() => expect(screen.getAllByLabelText("Review notes")).toHaveLength(2));
  const fields = screen.getAllByLabelText("Review notes") as HTMLTextAreaElement[];
  expect(fields.map(field => field.value)).toEqual(["", "Only revision 12"]);
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh history" }).hasAttribute("disabled")).toBe(false));
  expect((screen.getAllByLabelText("Review notes") as HTMLTextAreaElement[]).map(field => field.value)).toEqual(["", "Only revision 12"]);
});

it("shows the selected history immediately and retries a local read failure", async () => {
  const onListRevisions = vi.fn().mockRejectedValueOnce(new Error("History unavailable")).mockResolvedValueOnce([revision]);
  renderCard({ skills: [skill], onListRevisions });
  const trigger = screen.getByRole("button", { name: "Review and history" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(trigger.getAttribute("aria-controls")!)?.hidden).toBe(false);
  expect(screen.getByText("Loading history for Briefing…")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Retry history" }));
  expect(await screen.findByLabelText("Review notes")).toBeTruthy();
  expect(onListRevisions).toHaveBeenCalledTimes(2);
  expect(document.activeElement).not.toBe(document.body);
});

it("sends trimmed release notes with the exact revision, audience and preview snapshot", async () => {
  const { onActivateRevision } = renderCard({ skills: [skill] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "  Evidence checked  " } });
  fireEvent.click(screen.getByRole("radio", { name: "Test users" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview release" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(onActivateRevision).toHaveBeenCalledWith({ skillId: "briefing", skillRevisionId: 12, reviewNotes: "Evidence checked", audience: "test-users", expectedSnapshot: snapshot }));
  expect(screen.queryByRole("button", { name: /Discard unsent notes/ })).toBeNull();
});

it("retains notes and the last revisions when a history refresh fails", async () => {
  const onListRevisions = vi.fn().mockResolvedValueOnce([revision]).mockRejectedValueOnce(new Error("Read interrupted"));
  renderCard({ skills: [skill], onListRevisions });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "Keep my evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await screen.findByRole("button", { name: "Retry history" });
  expect(screen.getByRole("alert").textContent).toContain("Showing the last loaded revisions");
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("Keep my evidence");
});

it("a delayed release does not delete newer notes entered after reopening history", async () => {
  let finish!: () => void;
  const onActivateRevision = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  renderCard({ skills: [skill], onActivateRevision });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(await screen.findByLabelText("Review notes"), { target: { value: "Submitted evidence" } });
  fireEvent.click(screen.getByRole("radio", { name: "Test users" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview release" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(onActivateRevision).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Hide history" }));
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.change(screen.getByLabelText("Review notes"), { target: { value: "New evidence after reopen" } });
  await act(async () => { finish(); });
  await screen.findByRole("button", { name: "Refresh history" });
  expect((screen.getByLabelText("Review notes") as HTMLTextAreaElement).value).toBe("New evidence after reopen");
  expect(screen.getByRole("button", { name: /Discard unsent notes/ })).toBeTruthy();
});

const acceptedContent = { name: "Accepted briefing", description: "Accepted purpose", instructions: "Use the accepted evidence only." };
const acceptedDetail: OrganizationSkillSubmissionDetail = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", version: 2, status: "accepted", authorUserId: "author", authorName: "Author", authorEmail: null,
  sourceSkillId: "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", targetOrganizationSkillId: null, acceptedOrganizationSkillId: "briefing",
  latest: { attempt: 1, status: "accepted", note: "", snapshot: { content: { ...acceptedContent, name: "Submitted name" }, sourceRevision: 2, contentHash: "a".repeat(64), validationMessages: [] },
    submittedAt: skill.createdAt, decidedAt: skill.createdAt, decidedBy: "admin", decidedByName: "Admin", feedback: null, acceptedRevisionId: 12 },
  attempts: [], updates: [], organizationSkill: { skillId: "briefing", version: 0, enabled: false, isPublished: false,
    activeRevisionId: null, currentDraftRevisionId: 12, activeContent: null, currentDraftContent: acceptedContent }, createdAt: skill.createdAt, updatedAt: skill.updatedAt
};
const acceptedRow = { ...revision, metadata: { skillName: acceptedContent.name, description: acceptedContent.description, instructions: acceptedContent.instructions,
  organizationSubmissionId: acceptedDetail.id, organizationSubmissionAttempt: 1 } };
const acceptedScope = { tenantId: "tenant-a", userId: "admin-a" };
const handoff = acceptedSkillDraft(acceptedDetail, acceptedScope)!;

it.each([false, true])("opens exact pending content for accepted new/update %s and saves the next revision without release", async update => {
  const detail = update ? { ...acceptedDetail, targetOrganizationSkillId: "briefing", organizationSkill: { ...acceptedDetail.organizationSkill!, activeRevisionId: 11, enabled: true, version: 4 } } : acceptedDetail;
  const draft = acceptedSkillDraft(detail, acceptedScope)!;
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope: acceptedScope, submission: detail });
  const { onImportInline, onActivateRevision } = renderCard({ skills: [{ ...skill, activeRevisionId: update ? 11 : null }], acceptedDraft: draft, onListRevisions: async () => [acceptedRow] });
  const dialog = await screen.findByRole("dialog");
  expect(screen.getByRole("dialog", { description: "Editing draft r1, revision #12. Accepted revision #12 stays in submission history. Saving creates a new revision." })).toBe(dialog);
  expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe(acceptedContent.name);
  expect((within(dialog).getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe(acceptedContent.instructions);
  fireEvent.change(within(dialog).getByLabelText("Instructions (SKILL.md body)"), { target: { value: "New immutable revision." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save as new revision" }));
  await waitFor(() => expect(onImportInline).toHaveBeenCalledWith({ skillId: "briefing", skillName: acceptedContent.name, description: acceptedContent.description, instructions: "New immutable revision." }));
  expect(onActivateRevision).not.toHaveBeenCalled();
  expect(acceptedDetail.latest.snapshot.content.name).toBe("Submitted name");
});

it.each(["scope", "submission", "target", "version", "draft", "content", "missing", "provenance", "newer"])("rejects a changed or unavailable accepted %s", async change => {
  const detail = structuredClone(acceptedDetail);
  const scope = { ...acceptedScope };
  let rows = [structuredClone(acceptedRow)];
  if (change === "scope") scope.tenantId = "elsewhere";
  if (change === "submission") detail.version++;
  if (change === "target") detail.acceptedOrganizationSkillId = "neighbor";
  if (change === "version") detail.organizationSkill!.version++;
  if (change === "draft") detail.organizationSkill!.currentDraftRevisionId = 13;
  if (change === "content") rows[0].metadata.instructions = "Different text";
  if (change === "missing") rows = [];
  if (change === "provenance") rows[0].metadata.organizationSubmissionId = "another";
  if (change === "newer") rows.push({ ...rows[0], skillRevisionId: 13, revisionNumber: 2 });
  expect(() => verifyAcceptedSkillDraft(handoff, { scope, submission: detail }, rows)).toThrow(/changed or is no longer available/);
});

it("keeps edits and blocks import if the draft changes before save", async () => {
  vi.mocked(getAdminSkillSubmission).mockResolvedValueOnce({ scope: acceptedScope, submission: acceptedDetail })
    .mockResolvedValue({ scope: acceptedScope, submission: { ...acceptedDetail, organizationSkill: { ...acceptedDetail.organizationSkill!, currentDraftRevisionId: 13 } } });
  const { onImportInline } = renderCard({ acceptedDraft: handoff, onListRevisions: async () => [acceptedRow] });
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Keep these changes" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save as new revision" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("changed"));
  expect((within(dialog).getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe("Keep these changes");
  expect(onImportInline).not.toHaveBeenCalled();
});

it.each(["unmount", "scope replacement"])("does not import after %s while save validation is held", async change => {
  let finish!: (response: Awaited<ReturnType<typeof getAdminSkillSubmission>>) => void;
  vi.mocked(getAdminSkillSubmission).mockResolvedValueOnce({ scope: acceptedScope, submission: acceptedDetail })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = renderCard({ acceptedDraft: handoff, onListRevisions: async () => [acceptedRow] });
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Old scope text" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save as new revision" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  if (change === "unmount") view.unmount();
  else view.replaceScope();
  await act(async () => { finish({ scope: acceptedScope, submission: acceptedDetail }); });
  expect(view.onImportInline).not.toHaveBeenCalled();
});

it("rejects a late handoff response after another target is requested", async () => {
  let finish!: (response: Awaited<ReturnType<typeof getAdminSkillSubmission>>) => void;
  vi.mocked(getAdminSkillSubmission).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockRejectedValueOnce(new Error("Selected draft read failed"));
  const { rerender } = renderCard({ acceptedDraft: handoff, onListRevisions: async () => [acceptedRow] });
  rerender({ acceptedDraft: { ...handoff, submissionId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", skillId: "neighbor" }, onListRevisions: async () => [acceptedRow] });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Selected draft read failed");
  await act(async () => finish({ scope: acceptedScope, submission: acceptedDetail }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("loads the current pending successor while retaining the accepted revision identity", () => {
  const next = { ...acceptedRow, skillRevisionId: 13, revisionNumber: 2, metadata: { ...acceptedRow.metadata, instructions: "Later draft text" } };
  const detail = { ...acceptedDetail, organizationSkill: { ...acceptedDetail.organizationSkill!, currentDraftRevisionId: 13,
    currentDraftContent: { ...acceptedContent, instructions: "Later draft text" } } };
  const draft = acceptedSkillDraft(detail, acceptedScope)!;
  expect(draft.acceptedRevisionId).toBe(12);
  expect(verifyAcceptedSkillDraft(draft, { scope: acceptedScope, submission: detail }, [next, acceptedRow])).toBe(next);
});


it("refuses a current draft owned by a newer accepted submission", () => {
  const next = { ...acceptedRow, skillRevisionId: 13, revisionNumber: 2, metadata: { ...acceptedRow.metadata, organizationSubmissionId: "another-submission" } };
  const detail = { ...acceptedDetail, organizationSkill: { ...acceptedDetail.organizationSkill!, currentDraftRevisionId: 13 } };
  const draft = acceptedSkillDraft(detail, acceptedScope)!;
  expect(() => verifyAcceptedSkillDraft(draft, { scope: acceptedScope, submission: detail }, [next, acceptedRow])).toThrow(/changed/);
});

it("waits for an open dirty editor before loading a requested accepted draft", async () => {
  const active = { ...acceptedRow, skillRevisionId: 11, reviewStatus: "active" };
  const { rerender } = renderCard({ skills: [{ ...skill, activeRevisionId: 11, enabled: true }], onListRevisions: async () => [active] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const instructions = within(screen.getByRole("dialog")).getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement;
  fireEvent.change(instructions, { target: { value: "Keep my current editor" } });
  vi.mocked(getAdminSkillSubmission).mockClear();
  rerender({ acceptedDraft: handoff, onListRevisions: async () => [acceptedRow] });
  expect(instructions.value).toBe("Keep my current editor");
  expect(getAdminSkillSubmission).not.toHaveBeenCalled();
  expect(screen.getByText("Finish or cancel the open editor first. Your current edits are kept.")).toBeTruthy();
  vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(instructions.isConnected).toBe(true);
  vi.mocked(window.confirm).mockReturnValueOnce(true);
  vi.mocked(getAdminSkillSubmission).mockResolvedValue({ scope: acceptedScope, submission: acceptedDetail });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect((within(screen.getByRole("dialog")).getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe(acceptedContent.instructions));
  vi.mocked(window.confirm).mockRestore();
});
