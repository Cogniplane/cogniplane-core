// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this private revision 2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create draft from private source" }));
  await waitFor(() => expect(projectApi.updateProjectSkillFromPersonal).toHaveBeenCalledWith("project", copied.id, {
    scope, version: 1, sourceRevision: 2
  }));
  expect(screen.getByText("Revision 1, available")).toBeTruthy();
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
  expect(screen.getByText(/No project skills yet/)).toBeTruthy();
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
  expect(screen.getByText(/No project skills yet/)).toBeTruthy();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function editDraft() {
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep my new instructions." } });
}
const conflictError = () => new ApiError({ status: 409, code: "project_skill_conflict", method: "PUT", path: "/projects/project/skills/id", message: "Changed elsewhere" });

it("keeps the pending save focusable, rejects duplicate input and shows failure beside the save", async () => {
  const held = deferred<{ scope: typeof scope; skill: ProjectSkill }>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockReturnValue(held.promise);
  show(); await editDraft();
  const save = screen.getByRole("button", { name: "Save draft" });
  save.focus();
  fireEvent.click(save); fireEvent.click(save);
  expect(projectApi.updateProjectSkill).toHaveBeenCalledTimes(1);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect((save as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(save);
  held.reject(new Error("Service unavailable"));
  await screen.findByText("Service unavailable");
  expect(save.parentElement?.parentElement?.textContent).toContain("Service unavailable");
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep my new instructions.");
  expect(document.activeElement).toBe(save);
});

it("does not take focus when a held save completes after the person moved away", async () => {
  const held = deferred<{ scope: typeof scope; skill: ProjectSkill }>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockReturnValue(held.promise);
  render(<><button>Outside</button><ProjectSkills scope={scope} projectName="Planning" canManage archived={false} /></>);
  await editDraft();
  const save = screen.getByRole("button", { name: "Save draft" }); save.focus(); fireEvent.click(save);
  const outside = screen.getByRole("button", { name: "Outside" }); outside.focus();
  held.resolve({ scope, skill: { ...draft, version: 2 } });
  await screen.findByText(/Draft revision 1 saved/);
  expect(document.activeElement).toBe(outside);
});

it("blocks edits after a conflict reread fails, including after cancel, until explicit recovery", async () => {
  const latest = { ...draft, version: 2, latest: { ...revision, revision: 2 } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable"))
    .mockResolvedValue({ scope, canEdit: true, skills: [latest] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    show(); await editDraft();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Latest project skills could not be loaded");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep my new instructions.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Edit draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Edit draft" }) as HTMLButtonElement).disabled).toBe(false));
    expect(projectApi.updateProjectSkill).toHaveBeenCalledTimes(1);
  } finally { confirm.mockRestore(); }
});

it("keeps text after failed reread and requires a version choice after recovery", async () => {
  const latest = { ...draft, version: 2, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other owner's text" } } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable"))
    .mockResolvedValue({ scope, canEdit: true, skills: [latest] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  show(); await editDraft();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Latest project skills could not be loaded");
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  expect(await screen.findByRole("group", { name: "Latest saved version" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my text" }));
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false);
  expect(projectApi.updateProjectSkill).toHaveBeenCalledTimes(1);
});

it("names the shown and released revisions and resets release review after a conflict", async () => {
  const skill = { ...draft, version: 4, enabled: true, active: revision, latest: { ...revision, revision: 3 } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [skill] })
    .mockResolvedValue({ scope, canEdit: true, skills: [{ ...skill, version: 5, latest: { ...revision, revision: 4 } }] });
  vi.mocked(projectApi.actOnProjectSkill).mockRejectedValue(conflictError());
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  expect(screen.getByText("Revision 1, available")).toBeTruthy();
  expect(screen.getByText("Draft revision 3, not released")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /draft revision 3 and its validation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Release in Planning" }));
  await screen.findByText("Draft revision 4, not released");
  expect(projectApi.actOnProjectSkill).toHaveBeenCalledWith("project", draft.id, { scope, version: 4, action: "release" });
  expect((screen.getByRole("checkbox", { name: /draft revision 4 and its validation/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "Release in Planning" }) as HTMLButtonElement).disabled).toBe(true);
});

it("closes history and returns focus to its opener", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  const close = await screen.findByRole("button", { name: "Close history" }); close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByText("Revision history")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "History" }));
});

it("clears a scope's draft and ignores its held save result after the scope changes", async () => {
  const held = deferred<{ scope: typeof scope; skill: ProjectSkill }>();
  const changed = vi.fn();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockReturnValue(held.promise);
  const view = render(<ProjectSkills scope={scope} projectName="Planning" canManage archived={false} onChanged={changed} />);
  await editDraft(); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const nextScope = { ...scope, userId: "next-owner" };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope: nextScope, canEdit: true, skills: [] });
  view.rerender(<ProjectSkills scope={nextScope} projectName="Planning" canManage archived={false} onChanged={changed} />);
  await screen.findByText(/No project skills yet/);
  await act(async () => { held.resolve({ scope, skill: draft }); });
  fireEvent.click(screen.getByRole("button", { name: "Create project skill" }));
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("");
  expect(changed).not.toHaveBeenCalled();
});

it.each([401, 409])("clears draft text on a session or scope lock, status %s", async (status) => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(new ApiError({ status, code: status === 401 ? "unauthorized" : "project_skill_scope_changed", method: "PUT", path: "/projects/project/skills/id", message: "Scope lost" }));
  show(); await editDraft();
  const save = screen.getByRole("button", { name: "Save draft" }); save.focus(); fireEvent.click(save);
  await screen.findByText(/Draft text has been cleared/);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Project skills" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
});

it("ignores a file read that completes after an account change", async () => {
  const file = deferred<string>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [] });
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.change(screen.getByLabelText("Upload SKILL.md"), { target: { files: [{ name: "SKILL.md", size: 20, text: () => file.promise }] } });
  await screen.findByText("Reading SKILL.md…");
  const nextScope = { ...scope, userId: "next-owner" };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope: nextScope, canEdit: true, skills: [] });
  view.rerender(<ProjectSkills scope={nextScope} projectName="Planning" canManage archived={false} />);
  await screen.findByRole("button", { name: "Create project skill" });
  await act(async () => { file.resolve("Previous account's private instructions"); });
  fireEvent.click(screen.getByRole("button", { name: "Create project skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  expect((screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement).value).toBe("");
});

it("shows an active-work refusal at release and keeps the existing released revision", async () => {
  const skill = { ...draft, enabled: true, active: revision, latest: { ...revision, revision: 3 } };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [skill] });
  vi.mocked(projectApi.actOnProjectSkill).mockRejectedValue(new ApiError({ status: 409, code: "project_busy", method: "POST", path: "/projects/project/skills/id/action", message: "Finish active project turns and resolve pending approvals before changing released skills." }));
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /draft revision 3 and its validation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Release in Planning" }));
  await screen.findByText(/Finish active project turns/);
  const release = screen.getByRole("button", { name: "Release in Planning" });
  expect(release.parentElement?.textContent).toContain("Finish active project turns");
  expect(screen.getByText("Revision 1, available")).toBeTruthy();
  expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(1);
  expect(projectApi.actOnProjectSkill).toHaveBeenCalledTimes(1);
});

// Characterization for issue 98 (https://github.com/Cogniplane/cogniplane-core/issues/98).
// Tests named "current behavior" pin existing quirks so the editor refactor keeps them.
// They record behavior, not approved UX. Change one only in a separate, approved fix.
type EditorProps = ComponentProps<typeof ProjectSkills>;
type ListResponse = Awaited<ReturnType<typeof projectApi.getProjectSkills>>;
type SkillResponse = Awaited<ReturnType<typeof projectApi.createProjectSkill>>;
type HistoryResponse = Awaited<ReturnType<typeof projectApi.getProjectSkillHistory>>;
type PersonalResponse = Awaited<ReturnType<typeof personalApi.getPersonalSkill>>;
const personalScope = { tenantId: scope.tenantId, userId: scope.userId };
const copiedFrom = { mine: true, personalSkillId: privateSkill.id, revision: 1 };
const sourceAt = (number: number): PersonalSkill => ({ ...privateSkill,
  active: { ...revision, revision: number, content: { ...content, instructions: `Private revision ${number}.` } } });
const otherOwnersVersion: ProjectSkill = { ...draft, version: 2,
  latest: { ...revision, revision: 2, content: { ...content, instructions: "Other owner's text" } } };
const deletedMessage = "This skill was deleted elsewhere. It is no longer in this project.";
const apiError = (status: number, code: string, text: string) =>
  new ApiError({ status, code, method: "POST", path: "/projects/project/skills/id", message: text });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const checkbox = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const instructions = () => screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
const markdownText = () => screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement;
const skillFile = (text: () => Promise<string>) => ({ files: [{ name: "SKILL.md", size: 20, text }] });
const readBlock = "Latest project skills could not be loaded";
function mount(initial: Partial<EditorProps> = {}) {
  let props: EditorProps = { scope, projectName: "Planning", canManage: true, archived: false, ...initial };
  const view = render(<ProjectSkills {...props} />);
  return (next: Partial<EditorProps>) => { props = { ...props, ...next }; view.rerender(<ProjectSkills {...props} />); };
}
// Both clicks run in one React batch, so the second click uses the handler from before the first one.
function clickTwiceBeforeRender(element: HTMLElement) {
  act(() => {
    element.click();
    expect(element.getAttribute("aria-disabled")).toBe("false");
    element.click();
  });
}
async function conflictThenFailedReread() {
  fireEvent.click(button("Save draft"));
  await screen.findByText(readBlock);
}

it("clears the copy review when a different private skill with the same revision number is read", async () => {
  const other: PersonalSkill = { ...privateSkill, id: "personal-skill-00000000-0000-4000-8000-000000000003",
    active: { ...revision, content: { ...content, name: "status-report", instructions: "Report status." } } };
  const otherRead = deferred<PersonalResponse>();
  vi.mocked(personalApi.getPersonalSkills).mockResolvedValue({ scope: personalScope, skills: [privateSkill, other] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValueOnce({ scope: personalScope, skill: privateSkill })
    .mockReturnValueOnce(otherRead.promise);
  vi.mocked(projectApi.copyPersonalSkillToProject).mockResolvedValue({ scope, skill: draft });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Copy from my private skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "meeting-notes" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed this released revision 1/ }));
  expect(button("Create project draft").disabled).toBe(false);
  fireEvent.click(button("status-report"));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText("Loading released private revision…")).toBeTruthy();
  await act(async () => { otherRead.resolve({ scope: personalScope, skill: other }); });
  expect(screen.getByText("Report status.")).toBeTruthy();
  expect(checkbox(/I reviewed this released revision 1/).checked).toBe(false);
  expect(button("Create project draft").disabled).toBe(true);
  fireEvent.click(checkbox(/I reviewed this released revision 1/));
  fireEvent.click(button("Create project draft"));
  await waitFor(() => expect(projectApi.copyPersonalSkillToProject).toHaveBeenCalledWith("project", {
    scope, personalSkillId: other.id, sourceRevision: 1 }));
});

it("does not let a source review approve a newer private revision or project version", async () => {
  const copied: ProjectSkill = { ...draft, copiedFrom };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [copied] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValueOnce({ scope: personalScope, skill: sourceAt(2) })
    .mockResolvedValueOnce({ scope: personalScope, skill: sourceAt(3) });
  vi.mocked(projectApi.updateProjectSkillFromPersonal).mockResolvedValue({ scope, skill: { ...copied, version: 3 } });
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("Check my private source"));
  fireEvent.click(await screen.findByRole("checkbox", { name: /private revision 2/ }));
  expect(button("Create draft from private source").disabled).toBe(false);
  fireEvent.click(button("Check my private source"));
  expect(await screen.findByText(/Released private revision 3/)).toBeTruthy();
  expect(checkbox(/private revision 3/).checked).toBe(false);
  expect(button("Create draft from private source").disabled).toBe(true);
  fireEvent.click(checkbox(/private revision 3/));
  // A new access-failure callback reruns the mount list read. It changes the version and keeps the candidate.
  const effectRead = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockReturnValueOnce(effectRead.promise);
  update({ onAccessFailure: vi.fn() });
  await act(async () => { effectRead.resolve({ scope, canEdit: true, skills: [{ ...copied, version: 2 }] }); });
  expect(screen.getByText(/Released private revision 3/)).toBeTruthy();
  expect(checkbox(/private revision 3/).checked).toBe(false);
  expect(button("Create draft from private source").disabled).toBe(true);
  fireEvent.click(checkbox(/private revision 3/));
  fireEvent.click(button("Create draft from private source"));
  await waitFor(() => expect(projectApi.updateProjectSkillFromPersonal).toHaveBeenCalledWith("project", copied.id, {
    scope, version: 2, sourceRevision: 3 }));
});

it("keeps one review at a time and requires a new release review after a source update", async () => {
  const copied: ProjectSkill = { ...draft, version: 4, enabled: true, active: revision, latest: { ...revision, revision: 3 }, copiedFrom };
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [copied] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: personalScope, skill: sourceAt(2) });
  vi.mocked(projectApi.updateProjectSkillFromPersonal).mockResolvedValue({ scope,
    skill: { ...copied, version: 5, latest: { ...revision, revision: 4, copiedFromRevision: 2 } } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("Check my private source"));
  await screen.findByText(/Released private revision 2/);
  const release = () => checkbox(/I reviewed this draft revision/);
  const source = () => checkbox(/I reviewed this private revision 2/);
  fireEvent.click(release());
  expect([release().checked, source().checked]).toEqual([true, false]);
  fireEvent.click(source());
  expect([release().checked, source().checked]).toEqual([false, true]);
  expect(button("Release in Planning").disabled).toBe(true);
  fireEvent.click(release());
  expect([release().checked, source().checked]).toEqual([true, false]);
  expect(button("Create draft from private source").disabled).toBe(true);
  fireEvent.click(source());
  fireEvent.click(button("Create draft from private source"));
  expect(await screen.findByText(/Private revision 2 copied into draft revision 4/)).toBeTruthy();
  expect(release().checked).toBe(false);
  expect(button("Release in Planning").disabled).toBe(true);
  expect(screen.queryByText(/Released private revision 2/)).toBeNull();
});

it("ignores a held save after access changes and keeps the newer save pending", async () => {
  const older = deferred<SkillResponse>(), newer = deferred<SkillResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const update = mount(); await editDraft();
  fireEvent.click(button("Save draft"));
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(button("Save draft").disabled).toBe(false));
  expect(instructions().value).toBe("Keep my new instructions.");
  fireEvent.click(button("Save draft"));
  await act(async () => { older.resolve({ scope, skill: { ...draft, version: 2, latest: { ...revision, revision: 5 } } }); });
  expect(screen.queryByText(/Draft revision 5 saved/)).toBeNull();
  expect(button("Saving draft…").getAttribute("aria-disabled")).toBe("true");
  await act(async () => { newer.resolve({ scope, skill: { ...draft, version: 2, latest: { ...revision, revision: 2 } } }); });
  expect(screen.getByText(/Draft revision 2 saved/)).toBeTruthy();
  expect(projectApi.updateProjectSkill).toHaveBeenCalledTimes(2);
});

it("ignores an older access reload after a newer one starts", async () => {
  const older = deferred<ListResponse>(), newer = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const update = mount();
  await screen.findByRole("button", { name: "Details" });
  update({ archived: true }); update({ archived: false });
  await act(async () => { older.reject(new Error("Old read failed")); });
  expect(screen.queryByText(readBlock)).toBeNull();
  expect(screen.getByRole("status", { name: "Loading project skills" })).toBeTruthy();
  await act(async () => { newer.resolve({ scope, canEdit: true, skills: [{ ...draft, latest: { ...revision, content: { ...content, name: "fresh-notes" } } }] }); });
  expect(screen.getByText("fresh-notes")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading project skills" })).toBeNull();
});

it("ignores a held private skill read after access changes", async () => {
  const older = deferred<PersonalResponse>(), newer = deferred<PersonalResponse>();
  vi.mocked(personalApi.getPersonalSkill).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Copy from my private skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "meeting-notes" }));
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(button("meeting-notes").disabled).toBe(false));
  fireEvent.click(button("meeting-notes"));
  await act(async () => { older.resolve({ scope: personalScope, skill: sourceAt(1) }); });
  expect(screen.queryByText("Private revision 1.")).toBeNull();
  expect(screen.getByText("Loading released private revision…")).toBeTruthy();
  await act(async () => { newer.resolve({ scope: personalScope, skill: privateSkill }); });
  expect(screen.getByText("List decisions.")).toBeTruthy();
});

it("ignores a held history read after access changes and keeps the newer read pending", async () => {
  const older = deferred<HistoryResponse>(), newer = deferred<HistoryResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.getProjectSkillHistory).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  update({ canManage: false });
  await waitFor(() => expect(button("History").disabled).toBe(false));
  fireEvent.click(button("History"));
  await act(async () => { older.reject(new Error("Old history failed")); });
  expect(screen.queryByText("Old history failed")).toBeNull();
  expect(button("Loading history…").getAttribute("aria-disabled")).toBe("true");
  await act(async () => { newer.resolve({ scope, revisions: [revision] }); });
  expect(screen.getByText("Revision history")).toBeTruthy();
});

it("ignores a held file read after access changes and keeps the newer read pending", async () => {
  const older = deferred<string>(), newer = deferred<string>();
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));
  fireEvent.click(button("Import SKILL.md"));
  const upload = () => screen.getByLabelText("Upload SKILL.md") as HTMLInputElement;
  fireEvent.change(upload(), { target: skillFile(() => older.promise) });
  await screen.findByText("Reading SKILL.md…");
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(upload().disabled).toBe(false));
  fireEvent.change(upload(), { target: skillFile(() => newer.promise) });
  await act(async () => { older.resolve("Old file text"); });
  expect(markdownText().value).toBe("");
  expect(screen.getByText("Reading SKILL.md…")).toBeTruthy();
  await act(async () => { newer.resolve("New file text"); });
  expect(markdownText().value).toBe("New file text");
  expect(screen.queryByText("Reading SKILL.md…")).toBeNull();
});

it("starts one release and one source update when each is clicked twice before React renders", async () => {
  const copied: ProjectSkill = { ...draft, version: 4, enabled: true, active: revision, latest: { ...revision, revision: 3 }, copiedFrom };
  const release = deferred<SkillResponse>(), sourceUpdate = deferred<SkillResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [copied] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: personalScope, skill: sourceAt(2) });
  vi.mocked(projectApi.actOnProjectSkill).mockReturnValue(release.promise);
  vi.mocked(projectApi.updateProjectSkillFromPersonal).mockReturnValue(sourceUpdate.promise);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(checkbox(/I reviewed this draft revision 3/));
  clickTwiceBeforeRender(button("Release in Planning"));
  expect(projectApi.actOnProjectSkill).toHaveBeenCalledTimes(1);
  await act(async () => { release.resolve({ scope, skill: { ...copied, version: 5, active: { ...revision, revision: 3 } } }); });
  expect(screen.getByText(/Revision 3 released in Planning/)).toBeTruthy();
  fireEvent.click(button("Check my private source"));
  fireEvent.click(await screen.findByRole("checkbox", { name: /private revision 2/ }));
  clickTwiceBeforeRender(button("Create draft from private source"));
  expect(projectApi.updateProjectSkillFromPersonal).toHaveBeenCalledTimes(1);
  await act(async () => { sourceUpdate.resolve({ scope, skill: { ...copied, version: 6, latest: { ...revision, revision: 4, copiedFromRevision: 2 } } }); });
  expect(screen.getByText(/Private revision 2 copied into draft revision 4/)).toBeTruthy();
});

it("starts one copy when Create project draft is clicked twice before React renders", async () => {
  const held = deferred<SkillResponse>();
  vi.mocked(projectApi.copyPersonalSkillToProject).mockReturnValue(held.promise);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Copy from my private skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "meeting-notes" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed this released revision/ }));
  clickTwiceBeforeRender(button("Create project draft"));
  expect(projectApi.copyPersonalSkillToProject).toHaveBeenCalledTimes(1);
  await act(async () => { held.resolve({ scope, skill: draft }); });
  expect(screen.getByText(/Private revision copied into a separate project draft/)).toBeTruthy();
});

it("reads one file when two files are chosen in the same turn", async () => {
  const first = deferred<string>();
  const second = vi.fn(async () => "Second file");
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Create project skill" }));
  fireEvent.click(button("Import SKILL.md"));
  const upload = screen.getByLabelText("Upload SKILL.md");
  // React renders after each input change event, even inside one act() call.
  // The second choice still arrives before the first read finishes.
  const choose = (text: () => Promise<string>) => {
    Object.defineProperty(upload, "files", { configurable: true, value: skillFile(text).files });
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  };
  act(() => { choose(() => first.promise); choose(second); });
  expect(second).not.toHaveBeenCalled();
  await act(async () => { first.resolve("First file"); });
  expect(markdownText().value).toBe("First file");
});

it("current behavior: Use the latest version moves focus only at a later list change (issue 98 follow-up)", async () => {
  // Each read returns a new array, as a parsed response does. Focus waits for that list change.
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockImplementation(async () => ({ scope, canEdit: true, skills: [otherOwnersVersion] }));
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  const update = mount(); await editDraft();
  fireEvent.click(button("Save draft"));
  const useLatest = await screen.findByRole("button", { name: "Use the latest version" });
  useLatest.focus(); fireEvent.click(useLatest);
  expect(instructions().value).toBe("Other owner's text");
  expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
  expect(button("Save draft").disabled).toBe(true);
  const heading = screen.getByRole("heading", { name: "Edit meeting-notes" });
  expect(document.activeElement).not.toBe(heading);
  update({ canManage: false });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

it("saves the kept text of a skill deleted elsewhere as a new project draft", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(apiError(404, "project_skill_not_found", "Missing"));
  vi.mocked(projectApi.createProjectSkill).mockResolvedValue({ scope, skill: { ...draft, id: "project-skill-00000000-0000-4000-8000-000000000004" } });
  show(); await editDraft();
  fireEvent.click(button("Save draft"));
  await screen.findByText(/Save it as a new project draft or cancel/);
  fireEvent.click(button("Save draft"));
  await waitFor(() => expect(projectApi.createProjectSkill).toHaveBeenCalledWith("project", {
    scope, source: { kind: "inline", ...content, instructions: "Keep my new instructions." } }));
  expect(projectApi.updateProjectSkill).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/Draft revision 1 saved/)).toBeTruthy();
});

it("returns to the list when the skill shown in details was deleted elsewhere", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  vi.mocked(projectApi.actOnProjectSkill).mockRejectedValue(apiError(404, "project_skill_not_found", "Missing"));
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(checkbox(/I reviewed this draft revision 1/));
  fireEvent.click(button("Release in Planning"));
  expect(await screen.findByText(deletedMessage)).toBeTruthy();
  expect(screen.getByText(/No project skills yet/)).toBeTruthy();
});

it.each(["personal_source_changed", "personal_source_unavailable"])(
  "current behavior: shows %s beside the source update, keeps its review, and does not reload (issue 98 follow-up)", async (code) => {
    const copied: ProjectSkill = { ...draft, copiedFrom };
    vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [copied] });
    vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: personalScope, skill: sourceAt(2) });
    vi.mocked(projectApi.updateProjectSkillFromPersonal).mockRejectedValue(apiError(409, code, "Your private source changed."));
    show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    fireEvent.click(button("Check my private source"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /private revision 2/ }));
    fireEvent.click(button("Create draft from private source"));
    await screen.findByText("Your private source changed.");
    expect(button("Create draft from private source").parentElement?.parentElement?.textContent).toContain("Your private source changed.");
    expect(checkbox(/private revision 2/).checked).toBe(true);
    expect(screen.getByText(/Released private revision 2/)).toBeTruthy();
    expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(1);
  });

it("current behavior: a save refused with 403 shows the error twice and makes the editor read-only without a reload (issue 98 follow-up)", async () => {
  const accessFailure = vi.fn(async () => undefined);
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(apiError(403, "forbidden", "Only owners can change project skills."));
  mount({ onAccessFailure: accessFailure }); await editDraft();
  fireEvent.click(button("Save draft"));
  await screen.findAllByText("Only owners can change project skills.");
  expect(screen.getAllByText("Only owners can change project skills.")).toHaveLength(2);
  expect(screen.getByText(/Project skills are read-only/)).toBeTruthy();
  expect(instructions().value).toBe("Keep my new instructions.");
  expect(instructions().disabled).toBe(true);
  expect(accessFailure).toHaveBeenCalledTimes(1);
  expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(1);
});

it("treats an archived-project refusal like lost edit access", async () => {
  const accessFailure = vi.fn(async () => undefined);
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  vi.mocked(projectApi.actOnProjectSkill).mockRejectedValue(apiError(409, "project_archived", "Restore the project before changing it."));
  mount({ onAccessFailure: accessFailure });
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(checkbox(/I reviewed this draft revision 1/));
  fireEvent.click(button("Release in Planning"));
  expect(await screen.findByText("Restore the project before changing it.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Release in Planning" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  expect(accessFailure).toHaveBeenCalledTimes(1);
  expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(1);
});

it("blocks edits after the first list read fails until Reload skills succeeds", async () => {
  vi.mocked(projectApi.getProjectSkills).mockRejectedValueOnce(new Error("Read unavailable"))
    .mockResolvedValue({ scope, canEdit: true, skills: [draft] });
  show();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(readBlock);
  expect(alert.textContent).toContain("Read unavailable Editing and release are blocked");
  expect(screen.queryByRole("button", { name: "Create project skill" })).toBeNull();
  fireEvent.click(button("Reload skills"));
  await waitFor(() => expect(button("Create project skill").disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(button("Details")).toBeTruthy();
});

it("does not reopen an edit cancelled during an explicit recovery reload", async () => {
  const held = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable")).mockReturnValueOnce(held.promise);
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    show(); await editDraft(); await conflictThenFailedReread();
    fireEvent.click(button("Reload skills"));
    expect(button("Cancel").disabled).toBe(false);
    fireEvent.click(button("Cancel"));
    await act(async () => { held.resolve({ scope, canEdit: true, skills: [otherOwnersVersion] }); });
    expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(button("Edit draft"));
    expect(instructions().value).toBe("Other owner's text");
  } finally { confirm.mockRestore(); }
});

it("lets a read-only member open history while the list read is failing", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: false, skills: [draft] })
    .mockRejectedValue(new Error("Read unavailable"));
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  const update = mount({ canManage: false });
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  update({ onAccessFailure: vi.fn() });
  await screen.findByText(readBlock);
  fireEvent.click(button("History"));
  expect(await screen.findByText("Revision history")).toBeTruthy();
});

it("returns a read-only member to the list when history finds the skill deleted", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: false, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: false, skills: [] });
  vi.mocked(projectApi.getProjectSkillHistory).mockRejectedValue(apiError(404, "project_skill_not_found", "Missing"));
  show(false);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  expect(await screen.findByText(deletedMessage)).toBeTruthy();
  expect(screen.getByText(/No project skills yet/)).toBeTruthy();
});

it("reloads after a private skill read returns 404 and asks for a new source review", async () => {
  vi.mocked(personalApi.getPersonalSkill).mockRejectedValue(apiError(404, "personal_skill_not_found", "Private skill missing."));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Copy from my private skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "meeting-notes" }));
  expect(await screen.findByText("Private skill missing. Review the source again before trying to copy.")).toBeTruthy();
  expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "Copy a private skill into Planning" })).toBeTruthy();
});

it("shows the reload result beside the source check after a 404 when the project skill still exists", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [{ ...draft, copiedFrom }] });
  vi.mocked(personalApi.getPersonalSkill).mockRejectedValue(apiError(404, "personal_skill_not_found", "Private skill missing."));
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("Check my private source"));
  expect(await screen.findByText("Project skills were reloaded. Review the current revision before trying again.")).toBeTruthy();
  expect(projectApi.getProjectSkills).toHaveBeenCalledTimes(2);
});

it("current behavior: an access reload that drops the open skill leaves an empty details view (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  update({ canManage: false });
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading project skills" })).toBeNull());
  expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
  expect(screen.queryByRole("button", { name: "Back to skills" })).toBeNull();
  expect(screen.queryByText(/No project skills yet/)).toBeNull();
  expect(screen.queryByText(/This skill was deleted elsewhere/)).toBeNull();
});

it("current behavior: an access reload that drops the edited skill keeps the text, and Save sends nothing (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  const update = mount(); await editDraft();
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(button("Save draft").disabled).toBe(false));
  expect(instructions().value).toBe("Keep my new instructions.");
  expect(screen.getByRole("heading", { name: "Edit undefined" })).toBeTruthy();
  fireEvent.click(button("Save draft"));
  await waitFor(() => expect(button("Save draft").getAttribute("aria-disabled")).toBe("false"));
  expect(projectApi.updateProjectSkill).not.toHaveBeenCalled();
});

it("returns to the list with a deleted notice when a held recovery reload loses the target after Cancel and Back", async () => {
  const held = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable")).mockReturnValueOnce(held.promise);
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    show(); await editDraft(); await conflictThenFailedReread();
    fireEvent.click(button("Reload skills"));
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Back to skills"));
    await act(async () => { held.resolve({ scope, canEdit: true, skills: [] }); });
    expect(screen.getByText(deletedMessage)).toBeTruthy();
    expect(screen.getByText(/No project skills yet/)).toBeTruthy();
  } finally { confirm.mockRestore(); }
});

it("shows the read block and keeps Saving draft… on a natively disabled Save while a conflict reread is pending", async () => {
  const held = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] }).mockReturnValueOnce(held.promise);
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  show(); await editDraft();
  fireEvent.click(button("Save draft"));
  await screen.findByText(readBlock);
  const pendingSave = button("Saving draft…");
  expect(pendingSave.disabled).toBe(true);
  expect(pendingSave.getAttribute("aria-disabled")).toBe("true");
  expect(button("Reloading skills…").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => { held.resolve({ scope, canEdit: true, skills: [otherOwnersVersion] }); });
  expect(screen.queryByText(readBlock)).toBeNull();
  expect(screen.getByRole("group", { name: "Latest saved version" })).toBeTruthy();
  expect(button("Save draft").disabled).toBe(true);
});

it("closes history and drops the source candidate after an access reload even when the skill is unchanged", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [{ ...draft, copiedFrom }] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  vi.mocked(personalApi.getPersonalSkill).mockResolvedValue({ scope: personalScope, skill: sourceAt(2) });
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  await screen.findByText("Revision history");
  fireEvent.click(button("Check my private source"));
  await screen.findByText(/Released private revision 2/);
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(button("Check my private source").disabled).toBe(false));
  expect(screen.queryByText("Revision history")).toBeNull();
  expect(screen.queryByText(/Released private revision 2/)).toBeNull();
});

it("closes history after turning a skill off, although the skill ID is unchanged", async () => {
  const released: ProjectSkill = { ...draft, enabled: true, active: revision };
  const changed = vi.fn();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [released] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  vi.mocked(projectApi.actOnProjectSkill).mockResolvedValue({ scope, skill: { ...released, version: 2, enabled: false } });
  mount({ onChanged: changed });
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  await screen.findByText("Revision history");
  fireEvent.click(button("Turn off"));
  expect(await screen.findByText("This project skill is off for future turns.")).toBeTruthy();
  expect(screen.queryByText("Revision history")).toBeNull();
  expect(changed).toHaveBeenCalledTimes(1);
});

it("keeps history and review after a mount-effect list read, and clears them after Reload skills", async () => {
  const skill: ProjectSkill = { ...draft, version: 4, enabled: true, active: revision, latest: { ...revision, revision: 3 } };
  const release = () => checkbox(/I reviewed this draft revision 3/);
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [skill] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  const update = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  await screen.findByText("Revision history");
  fireEvent.click(release());
  const effectRead = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockReturnValueOnce(effectRead.promise);
  update({ onAccessFailure: vi.fn() });
  await act(async () => { effectRead.resolve({ scope, canEdit: true,
    skills: [{ ...skill, latest: { ...skill.latest, content: { ...content, description: "Updated purpose" } } }] }); });
  expect(screen.getByText("Updated purpose")).toBeTruthy();
  expect(screen.getByText("Revision history")).toBeTruthy();
  expect(release().checked).toBe(true);
  vi.mocked(projectApi.getProjectSkills).mockRejectedValueOnce(new Error("Read unavailable"));
  update({ onAccessFailure: vi.fn() });
  await screen.findByText(readBlock);
  expect(release().checked).toBe(true);
  fireEvent.click(button("Reload skills"));
  await waitFor(() => expect(screen.queryByText(readBlock)).toBeNull());
  expect(release().checked).toBe(false);
  expect(screen.queryByText("Revision history")).toBeNull();
});

it("current behavior: Cancel removes the cause from the read block, and the later reload message stays hidden in details (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable"))
    .mockResolvedValue({ scope, canEdit: true, skills: [{ ...draft, version: 2 }] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    show(); await editDraft(); await conflictThenFailedReread();
    expect(screen.getByRole("alert").textContent).toContain("Read unavailable");
    fireEvent.click(button("Cancel"));
    expect(screen.getByRole("alert").textContent).not.toContain("Read unavailable");
    expect(screen.getByRole("alert").textContent).toContain("Editing and release are blocked");
    fireEvent.click(button("Reload skills"));
    await waitFor(() => expect(button("Edit draft").disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Project skills were reloaded/)).toBeNull();
  } finally { confirm.mockRestore(); }
});

it("current behavior: closing history also clears an unrelated operation error (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValue({ scope, canEdit: true, skills: [{ ...draft, enabled: true, active: revision }] });
  vi.mocked(projectApi.getProjectSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  vi.mocked(projectApi.actOnProjectSkill).mockRejectedValue(new Error("Service unavailable"));
  show(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(button("History"));
  await screen.findByText("Revision history");
  fireEvent.click(button("Turn off"));
  await screen.findByText("Service unavailable");
  fireEvent.click(button("Close history"));
  expect(screen.queryByText("Service unavailable")).toBeNull();
});

it("current behavior: an access reload rebases kept text on the newer version without a choice (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [otherOwnersVersion] });
  vi.mocked(projectApi.updateProjectSkill).mockResolvedValue({ scope, skill: { ...otherOwnersVersion, version: 3 } });
  const update = mount(); await editDraft();
  update({ archived: true }); update({ archived: false });
  await waitFor(() => expect(button("Save draft").disabled).toBe(false));
  expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
  expect(instructions().value).toBe("Keep my new instructions.");
  fireEvent.click(button("Save draft"));
  await waitFor(() => expect(projectApi.updateProjectSkill).toHaveBeenCalledWith("project", draft.id, {
    scope, source: { kind: "inline", ...content, instructions: "Keep my new instructions." }, version: 2 }));
});

it("current behavior: Keep my text removes the focused choice without moving focus (issue 98 follow-up)", async () => {
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockResolvedValue({ scope, canEdit: true, skills: [otherOwnersVersion] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValue(conflictError());
  show(); await editDraft();
  fireEvent.click(button("Save draft"));
  const keep = await screen.findByRole("button", { name: "Keep my text" });
  keep.focus(); fireEvent.click(keep);
  expect(screen.queryByRole("button", { name: "Keep my text" })).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it("current behavior: a mount-effect list read can replace a recovery reload without a version choice (issue 98 follow-up)", async () => {
  const recoveryRead = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable")).mockReturnValueOnce(recoveryRead.promise)
    .mockResolvedValue({ scope, canEdit: true, skills: [otherOwnersVersion] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValueOnce(conflictError())
    .mockResolvedValue({ scope, skill: { ...otherOwnersVersion, version: 3 } });
  const update = mount(); await editDraft(); await conflictThenFailedReread();
  fireEvent.click(button("Reload skills"));
  update({ onAccessFailure: vi.fn() });
  await waitFor(() => expect(screen.queryByText(readBlock)).toBeNull());
  await act(async () => { recoveryRead.resolve({ scope, canEdit: true, skills: [draft] }); });
  expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
  expect(instructions().value).toBe("Keep my new instructions.");
  fireEvent.click(button("Save draft"));
  await waitFor(() => expect(projectApi.updateProjectSkill).toHaveBeenLastCalledWith("project", draft.id, expect.objectContaining({ version: 2 })));
});

it("locks the editor when a private skill response belongs to another account", async () => {
  vi.mocked(personalApi.getPersonalSkills).mockResolvedValue({ scope: { ...personalScope, userId: "other" }, skills: [privateSkill] });
  show();
  const open = await screen.findByRole("button", { name: "Copy from my private skills" });
  open.focus(); fireEvent.click(open);
  expect(await screen.findByText(/Your account, organization, or project changed/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "meeting-notes" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Project skills" }));
});

it("restores saved text and its clean baseline when unresolved recovery later finds the skill deleted", async () => {
  const recoveryRead = deferred<ListResponse>();
  vi.mocked(projectApi.getProjectSkills).mockResolvedValueOnce({ scope, canEdit: true, skills: [draft] })
    .mockRejectedValueOnce(new Error("Read unavailable")).mockReturnValueOnce(recoveryRead.promise)
    .mockResolvedValueOnce({ scope, canEdit: true, skills: [otherOwnersVersion] })
    .mockResolvedValue({ scope, canEdit: true, skills: [] });
  vi.mocked(projectApi.updateProjectSkill).mockRejectedValueOnce(conflictError())
    .mockResolvedValue({ scope, skill: { ...otherOwnersVersion, version: 3 } });
  const update = mount(); await editDraft(); await conflictThenFailedReread();
  fireEvent.click(button("Reload skills"));
  update({ onAccessFailure: vi.fn() });
  await waitFor(() => expect(button("Save draft").disabled).toBe(false));
  await act(async () => { recoveryRead.resolve({ scope, canEdit: true, skills: [draft] }); });
  fireEvent.click(button("Save draft"));
  await screen.findByText(/Draft revision 2 saved/);
  update({ archived: true });
  await screen.findByText("This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel.");
  expect(instructions().value).toBe("Keep my new instructions.");
  update({ archived: false });
  await waitFor(() => expect(button("Save draft").disabled).toBe(false));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    fireEvent.click(button("Cancel"));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  } finally { confirm.mockRestore(); }
});
