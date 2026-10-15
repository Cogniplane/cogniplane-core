// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { PersonalSkill, ProjectSkill } from "@cogniplane/shared-types";
import { ProjectSkills } from "./project-skills";
import * as projectApi from "@/lib/project-skills-api";
import * as personalApi from "@/lib/personal-skills-api";

vi.mock("@/lib/project-skills-api", () => ({
  getProjectSkills: vi.fn(), createProjectSkill: vi.fn(), updateProjectSkill: vi.fn(),
  copyPersonalSkillToProject: vi.fn(), updateProjectSkillFromPersonal: vi.fn(),
  actOnProjectSkill: vi.fn(), deleteProjectSkill: vi.fn(), getProjectSkillHistory: vi.fn()
}));
vi.mock("@/lib/personal-skills-api", () => ({ getPersonalSkills: vi.fn(), getPersonalSkill: vi.fn() }));
const scope = { tenantId: "tenant", userId: "owner", projectId: "project" };
const date = "2026-09-26T12:00:00.000Z";
const content = { name: "meeting-notes", description: "Write meeting notes", instructions: "List decisions." };
const revision = { revision: 1, content, validationMessages: [], createdAt: date, copiedFromRevision: null };
const draft: ProjectSkill = { id: "project-skill-00000000-0000-4000-8000-000000000001", version: 1,
  enabled: false, latest: revision, active: null, copiedFrom: null, updatedAt: date };
const privateSkill: PersonalSkill = { id: "personal-skill-00000000-0000-4000-8000-000000000002", version: 3,
  enabled: true, latest: { ...revision, revision: 2 }, active: { ...revision, revision: 1 }, updatedAt: date };
const show = (canManage = true, archived = false) => render(<ProjectSkills scope={scope} projectName="Planning" canManage={canManage} archived={archived} />);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [] });
  vi.mocked(personalApi.getPersonalSkills).mockResolvedValue({ scope: { tenantId: scope.tenantId, userId: scope.userId }, skills: [privateSkill] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: { tenantId: scope.tenantId, userId: scope.userId }, skill: privateSkill });
});
afterEach(cleanup);

it("creates a draft and requires review of its exact revision before release", async () => {
  vi.mocked(projectApi.createProjectSkill).mockResolvedValue({ scope, skill: draft });
  vi.mocked(projectApi.actOnProjectSkill).mockResolvedValue({ scope, skill: { ...draft, version: 2, enabled: true, active: revision } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(projectApi.createProjectSkill).toHaveBeenCalledWith("project", { scope, source: { kind: "inline", ...content } }));
  expect(screen.getByRole("button", { name: "Release in Planning" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this draft/ }));
  fireEvent.click(screen.getByRole("button", { name: "Release in Planning" }));
  await waitFor(() => expect(projectApi.actOnProjectSkill).toHaveBeenCalledWith("project", draft.id, { scope, version: 1, action: "release" }));
  expect(screen.getByText(/Released in this project/)).toBeTruthy();
});

it("copies only the released private revision after review, then offers project release", async () => {
  vi.mocked(projectApi.copyPersonalSkillToProject).mockResolvedValue({ scope, skill: { ...draft,
    copiedFrom: { mine: true, personalSkillId: privateSkill.id, revision: 1 },
    latest: { ...revision, copiedFromRevision: 1 } } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Copy from my private skills" }));
  fireEvent.click(await screen.findByRole("button", { name: content.name }));
  expect(await screen.findByText("Released private instructions to review")).toBeTruthy();
  expect(screen.getByText("List decisions.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this released revision/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create project draft" }));
  await waitFor(() => expect(projectApi.copyPersonalSkillToProject).toHaveBeenCalledWith("project", {
    scope, personalSkillId: privateSkill.id, sourceRevision: 1
  }));
  expect(screen.getByRole("button", { name: "Release in Planning" }).hasAttribute("disabled")).toBe(true);
});

it("shows details to members and archived owners without edit actions", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: false, skills: [draft] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  show(false);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  expect(screen.getByText("List decisions.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(await screen.findByText("Revision history")).toBeTruthy();
  cleanup();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  show(true, true);
  expect(await screen.findByText("Restore this project to change its skills.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create project skill" })).toBeNull();
});

it("reviews a newer private source before updating the project draft", async () => {
  const copied = { ...draft, enabled: true, active: revision,
    copiedFrom: { mine: true, personalSkillId: privateSkill.id, revision: 1 } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [copied] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: { tenantId: scope.tenantId, userId: scope.userId },
    skill: { ...privateSkill, active: { ...privateSkill.latest, revision: 2 } } });
  vi.mocked(projectApi.updateProjectSkillFromPersonal).mockResolvedValue({ scope, skill: { ...copied,
    version: 2, latest: { ...revision, revision: 2, copiedFromRevision: 2 } } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Check my private source" }));
  expect(await screen.findByText(/Released private revision 2/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create draft from private source" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this private revision." }));
  fireEvent.click(screen.getByRole("button", { name: "Create draft from private source" }));
  await waitFor(() => expect(projectApi.updateProjectSkillFromPersonal).toHaveBeenCalledWith("project", copied.id, {
    scope, version: 1, sourceRevision: 2
  }));
  expect(screen.getByText(/Project sessions still use revision 1/)).toBeTruthy();
});

it("requires a second click to delete a project skill", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.deleteProjectSkill).mockResolvedValue({ scope, deleted: true });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(projectApi.deleteProjectSkill).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  await waitFor(() => expect(projectApi.deleteProjectSkill).toHaveBeenCalledWith("project", draft.id, { scope, version: 1 }));
  expect(screen.getByText("No project skills yet.")).toBeTruthy();
});

it("locks a mismatched scope and keeps unsaved text after a version conflict", async () => {
  const newer: ProjectSkill = { ...draft, version: 2, latest: { ...revision, revision: 2, content: { ...content, instructions: "Owner B instructions." } } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValueOnce({ scope, canEdit: true, skills: [newer] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValueOnce(new ApiError({ status: 409, code: "project_skill_conflict", method: "PUT", path: "/projects/project/skills/id", message: "Changed" }))
    .mockResolvedValueOnce({ scope, skill: { ...newer, version: 3 } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "My new instructions" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText(/Your unsaved text is still here/)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("My new instructions");
  // The other owner's revision is visible, and the next save needs an explicit choice.
  expect(screen.getByRole("group", { name: "Latest saved version" }).textContent).toContain("Owner B instructions.");
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my text" }));
  expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(projectApi.updateProjectSkill).toHaveBeenLastCalledWith("project", draft.id, expect.objectContaining({ version: 2 })));
  cleanup();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope: { ...scope, userId: "other" }, canEdit: true, skills: [draft] });
  show();
  expect(await screen.findByText(/Your account, organization, or project changed/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create project skill" })).toBeNull();
});

it("turns an edit into a new draft when the skill was deleted elsewhere", async () => {
  vi.mocked(projectApi.getProjectSkills)
    .mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValueOnce(new ApiError({ status: 404,
    code: "project_skill_not_found", method: "PUT", path: "/projects/project/skills/id", message: "Missing" }));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep this text" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText(/Save it as a new project draft or cancel/)).toBeTruthy();
  expect(screen.getByText("Create a draft in Planning")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep this text");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("No project skills yet.")).toBeTruthy();
  vi.restoreAllMocks();
});

it("switches the draft source without reusing one source's input for the other", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));

    fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Write a skill" }));

    // React reports a reused input as switching between controlled and uncontrolled.
    const warnings = consoleError.mock.calls.map((call) => String(call[0])).filter((message) => /controlled/.test(message));
    expect(warnings).toEqual([]);
  } finally {
    consoleError.mockRestore();
  }
});

it("switches the draft source, asking first only when typed text would be lost", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));
    const markdownBox = () => screen.queryByRole("textbox", { name: "SKILL.md text" });

    // Nothing typed yet: switch without asking. The current source is a no-op.
    fireEvent.click(screen.getByRole("button", { name: "Write a skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
    expect(markdownBox()).toBeTruthy();
    // Each switch makes the empty source the new baseline, so a clean round trip never asks.
    fireEvent.click(screen.getByRole("button", { name: "Write a skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
    expect(confirm).not.toHaveBeenCalled();

    // Typed text: the switch asks, and a "No" keeps the text.
    fireEvent.change(markdownBox()!, { target: { value: "---\nname: notes\n---" } });
    // Choosing the source already in use keeps the text without asking.
    fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Write a skill" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((markdownBox() as HTMLTextAreaElement).value).toBe("---\nname: notes\n---");

    // A "Yes" discards it and starts the other source empty.
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Write a skill" }));
    expect(markdownBox()).toBeNull();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("");

    // The empty source is the new baseline, so switching back does not ask again.
    fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect((markdownBox() as HTMLTextAreaElement).value).toBe("");
  } finally {
    confirm.mockRestore();
  }
});
