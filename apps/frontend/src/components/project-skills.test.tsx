// @vitest-environment jsdom
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
