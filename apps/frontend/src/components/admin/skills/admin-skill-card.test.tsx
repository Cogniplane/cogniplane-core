// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSkill, SkillImportResponse, SkillRevision } from "@cogniplane/shared-types";
import { previewAdminSkillRelease } from "@/lib/admin-api";

import { AdminSkillCard } from "./admin-skill-card";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
vi.mock("@/lib/admin-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/admin-api")>()), previewAdminSkillRelease: vi.fn() }));

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
  return { onImportInline, onActivateRevision, onPublish, onUnpublish, rerenderWithSkill: (next: AdminSkill) => view.rerender(<AdminSkillCard {...props} skills={[next]} />),
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

it("offers draft saving and a re-enable path for the active revision", async () => {
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

it("keeps a pending revision as a draft without activating it", async () => {
  const { onActivateRevision } = renderCard({ skills: [skill] });
  fireEvent.click(screen.getByRole("button", { name: "Review and history" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save as draft" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
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
  expect(screen.queryByRole("button", { name: "Save as draft" })).toBeNull();
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
  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Briefing");
  expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Write a briefing");
  fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Write a short briefing." } });
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

  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe("Keep this.");
});
