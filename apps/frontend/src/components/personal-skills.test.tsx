// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import {
  actOnPersonalSkill, createPersonalSkill, deletePersonalSkill, getPersonalSkillHistory,
  getPersonalSkills, updatePersonalSkill
} from "@/lib/personal-skills-api";
import { listMySkillSubmissions } from "@/lib/organization-skill-submissions-api";
import { PersonalSkills } from "./personal-skills";

vi.mock("@/lib/personal-skills-api", () => ({
  actOnPersonalSkill: vi.fn(), createPersonalSkill: vi.fn(), deletePersonalSkill: vi.fn(),
  getPersonalSkillHistory: vi.fn(), getPersonalSkills: vi.fn(), updatePersonalSkill: vi.fn()
}));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/lib/organization-skill-submissions-api", () => ({
  getMySkillSubmission: vi.fn(), listMySkillSubmissions: vi.fn(), resubmitSkillSubmission: vi.fn(),
  submitPersonalSkill: vi.fn(), withdrawSkillSubmission: vi.fn()
}));
const scope = { tenantId: "tenant-a", userId: "person-a" };
const content = { name: "meeting-notes", description: "Prepare meeting notes", instructions: "Summarize decisions." };
const revision = { revision: 1, content, validationMessages: [], createdAt: "2026-09-26T12:00:00.000Z" };
const draft = { id: "skill-1", version: 1, enabled: false, latest: revision, active: null, updatedAt: revision.createdAt };
const released = { ...draft, version: 2, enabled: true, active: revision };
const scopeError = new ApiError({ status: 409, code: "personal_skill_scope_changed", method: "POST", path: "/me/skills", message: "Scope changed" });
const conflictError = new ApiError({ status: 409, code: "personal_skill_conflict", method: "POST", path: "/me/skills/skill-1/action", message: "Conflict" });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [] });
  vi.mocked(createPersonalSkill).mockResolvedValue({ scope, skill: draft });
  vi.mocked(updatePersonalSkill).mockResolvedValue({ scope, skill: draft });
  vi.mocked(actOnPersonalSkill).mockResolvedValue({ scope, skill: released });
  vi.mocked(deletePersonalSkill).mockResolvedValue({ scope, deleted: true });
  vi.mocked(getPersonalSkillHistory).mockResolvedValue({ scope, revisions: [revision] });
  vi.mocked(listMySkillSubmissions).mockResolvedValue({ scope, submissions: [] });
});
afterEach(cleanup);

it("creates a draft, reviews server content, then releases it explicitly", async () => {
  const onChanged = vi.fn();
  render(<PersonalSkills expectedScope={scope} onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(createPersonalSkill).toHaveBeenCalledWith({ scope, source: { kind: "inline", ...content } }));
  expect(await screen.findByText("Instructions in draft revision 1")).toBeTruthy();
  expect(screen.getByText("Nothing yet. No revision is released.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Make revision 1 available" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed revision 1 and its validation messages." }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available" }));
  await waitFor(() => expect(actOnPersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 1, action: "release" }));
  expect(await screen.findByText("Revision 1 is in use")).toBeTruthy();
  expect(screen.getByText("Revision 1, in use")).toBeTruthy();
  expect(screen.getByText("Instructions in revision 1")).toBeTruthy();
  expect(onChanged).toHaveBeenCalledOnce();
});

it("keeps imported text when validation fails and shows server warnings after a successful save", async () => {
  vi.mocked(createPersonalSkill).mockRejectedValueOnce(new ApiError({ status: 400, code: "invalid_skill", method: "POST", path: "/me/skills", message: "Invalid SKILL.md" }));
  vi.mocked(createPersonalSkill).mockResolvedValueOnce({ scope, skill: { ...draft, latest: { ...revision, validationMessages: ["Companion files are not saved."] } } });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md text" }), { target: { value: "bad markdown" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const failed = await screen.findByRole("alert");
  expect(failed.textContent).toContain("Draft not saved");
  expect(failed.textContent).toContain("Invalid SKILL.md");
  expect((screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement).value).toBe("bad markdown");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Companion files are not saved.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  expect((screen.getByRole("button", { name: "Make revision 1 available" }) as HTMLButtonElement).disabled).toBe(false);
});

it("saves a new draft while the active revision remains in use", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  const newRevision = { ...revision, revision: 2, content: { ...content, instructions: "Write actions." } };
  vi.mocked(updatePersonalSkill).mockResolvedValue({ scope, skill: { ...released, version: 3, latest: newRevision } });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Write actions." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(updatePersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 2, source: { kind: "inline", ...content, instructions: "Write actions." } }));
  const release = await screen.findByRole("group", { name: "Review draft revision 2" });
  expect(release.textContent).toContain("Release replaces revision 1 with revision 2 as the revision in use.");
  expect(screen.getByText("Revision 1")).toBeTruthy();
  expect(screen.getByText("Draft revision 2, not released")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "I reviewed revision 2 and its validation messages." })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Make revision 2 available" })).toBeTruthy();
});

it("keeps an edit through a conflict and requires a fresh review before release", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [draft] }).mockResolvedValueOnce({ scope, skills: [{ ...draft, version: 2 }] });
  vi.mocked(actOnPersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Conflict Review the current version"));
  expect((screen.getByRole("button", { name: "Make revision 1 available" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available" }));
  await waitFor(() => expect(actOnPersonalSkill).toHaveBeenLastCalledWith("skill-1", { scope, version: 2, action: "release" }));
});

it("shows the newer revision after an edit conflict and saves only after Keep my text", async () => {
  const newer = { ...released, version: 3, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other tab text." } } };
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] }).mockResolvedValueOnce({ scope, skills: [newer] });
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(new ApiError({ status: 409, code: "personal_skill_conflict", method: "PUT", path: "/me/skills/skill-1", message: "Conflict" }));
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "My text." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const latest = await screen.findByRole("group", { name: "Latest saved version" });
  expect(latest.textContent).toContain("Other tab text.");
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("My text.");
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my text" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(updatePersonalSkill).toHaveBeenLastCalledWith("skill-1", { scope, version: 3, source: { kind: "inline", ...content, instructions: "My text." } }));
});

it("locks the page when a response or error has another scope", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope: { ...scope, userId: "person-b" }, skills: [draft] });
  render(<PersonalSkills expectedScope={scope} />);
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByText(content.name)).toBeNull();
  cleanup();
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [draft] });
  vi.mocked(actOnPersonalSkill).mockRejectedValueOnce(scopeError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available" }));
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByText(content.name)).toBeNull();
});

it("shows a session-expired message after a failed auth retry", async () => {
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new ApiError({
    status: 401, code: "unauthorized", method: "GET", path: "/me/skills", message: "Unauthorized"
  }));
  render(<PersonalSkills expectedScope={scope} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Your session expired"));
  expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Create skill" }) as HTMLButtonElement).disabled).toBe(true);
});

it("requires deletion confirmation and can show revision history", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect((await screen.findByRole("region", { name: "Revision history" })).textContent).toContain("Revision 1");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(deletePersonalSkill).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  await waitFor(() => expect(deletePersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 2 }));
  expect(await screen.findByText(/No private skills saved/)).toBeTruthy();
  expect(screen.getByText("Deleted meeting-notes and its revision history").closest("[role=status]")).toBeTruthy();
});

it("does not show a deleted skill's history while reviewing a new imported skill", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  vi.mocked(createPersonalSkill).mockResolvedValue({ scope, skill: {
    ...draft, id: "skill-2", latest: { ...revision, content: { ...content, name: "imported-notes" } }
  } });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(await screen.findByRole("region", { name: "Revision history" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md text" }), { target: { value: "---\nname: imported-notes\ndescription: Imported\n---\n\nWrite notes." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Instructions in draft revision 1")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "imported-notes" })).toBeTruthy();
  expect(screen.queryByText("Revision history")).toBeNull();
  expect(screen.queryByText("meeting-notes", { exact: false })).toBeNull();
});

it("keeps the server message for a skill limit conflict", async () => {
  vi.mocked(createPersonalSkill).mockRejectedValueOnce(new ApiError({
    status: 409, code: "personal_skill_limit", method: "POST", path: "/me/skills", message: "You have reached the private skill limit."
  }));
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("You have reached the private skill limit."));
  expect(getPersonalSkills).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(content.instructions);
});

it("can cancel an unsaved create draft", async () => {
  const onDirtyChange = vi.fn();
  render(<PersonalSkills expectedScope={scope} onDirtyChange={onDirtyChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "draft" } });
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(await screen.findByText(/No private skills saved/)).toBeTruthy();
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it("moves focus between views and marks the selected source", async () => {
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Create a draft" }));
  const write = screen.getByRole("button", { name: "Write a skill" });
  const imported = screen.getByRole("button", { name: "Import SKILL.md" });
  expect(write.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(imported);
  expect(imported.getAttribute("aria-pressed")).toBe("true");
  expect(write.getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md text" }), { target: { value: "a skill" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("heading", { name: content.name })).toBe(document.activeElement);
  fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Private skills" }));
});

it("keeps an unsaved editor when Cancel is declined", async () => {
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog", { name: "Discard unsaved skill changes?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("unsaved");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Private skills" })));
});

it("rejects an oversized Markdown upload before reading it", async () => {
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  const read = vi.fn();
  fireEvent.change(screen.getByLabelText("Upload SKILL.md"), { target: { files: [{ name: "SKILL.md", size: 512001, text: read }] } });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("too large"));
  expect(read).not.toHaveBeenCalled();
});

it("focuses the deletion choice and restores focus when it is kept", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep skill" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
});

it("turns off an active skill and keeps a saved selection limit error", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  vi.mocked(actOnPersonalSkill).mockResolvedValueOnce({ scope, skill: { ...released, version: 3, enabled: false } });
  vi.mocked(actOnPersonalSkill).mockRejectedValueOnce(new ApiError({
    status: 409, code: "personal_skill_defaults_full", method: "POST", path: "/me/skills/skill-1/action",
    message: "Your saved skill selection is full. Remove a skill from Chat defaults first."
  }));
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(actOnPersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 2, action: "disable" }));
  expect(await screen.findByText("meeting-notes is off")).toBeTruthy();
  expect(screen.getByText("Nothing. Revision 1 is off.")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Make revision 1 available again" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available again" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Your saved skill selection is full. Remove a skill from Chat defaults first."));
  expect(getPersonalSkills).toHaveBeenCalledTimes(1);
});

it("recovers a deleted skill after a 404 without losing edited text", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] }).mockResolvedValueOnce({ scope, skills: [] });
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(new ApiError({
    status: 404, code: "personal_skill_not_found", method: "PUT", path: "/me/skills/skill-1", message: "Skill not found"
  }));
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep these notes." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("deleted elsewhere"));
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep these notes.");
  expect(screen.getByRole("heading", { name: "Create a draft" })).toBe(document.activeElement);
});

it("shows a failed list read without claiming there are no skills", async () => {
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("Read failed"));
  render(<PersonalSkills expectedScope={scope} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Read failed"));
  expect(screen.queryByText(/No private skills saved/)).toBeNull();
  const retry = screen.getByRole("button", { name: "Reload skills" });
  retry.focus();
  fireEvent.click(retry);
  expect(await screen.findByText(/No private skills saved/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Private skills" }));
});

it("blocks writes after a failed conflict reread and retries only the read", async () => {
  const newer = { ...released, version: 3, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other text." } } };
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] })
    .mockRejectedValueOnce(new Error("Read unavailable"))
    .mockResolvedValueOnce({ scope, skills: [newer] });
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep my draft." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const retry = await screen.findByRole("button", { name: "Reload latest version" });
  const recovery = screen.getByRole("group", { name: "Reload current skill" });
  expect(recovery.textContent).toContain("Conflict");
  expect(recovery.textContent).toContain("Read unavailable");
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep my draft.");
  fireEvent.click(retry);
  await screen.findByRole("group", { name: "Latest saved version" });
  expect(screen.queryByText("Draft not saved")).toBeNull();
  expect(screen.queryByRole("group", { name: "Reload current skill" })).toBeNull();
  expect(updatePersonalSkill).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my text" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(updatePersonalSkill).toHaveBeenLastCalledWith("skill-1", { scope, version: 3, source: { kind: "inline", ...content, instructions: "Keep my draft." } }));
});

it("names the pending history read and preserves focus moved away during it", async () => {
  let resolve!: (value: { scope: typeof scope; revisions: typeof revision[] }) => void;
  vi.mocked(getPersonalSkillHistory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  const historyButton = screen.getByRole("button", { name: "History" });
  historyButton.focus();
  fireEvent.click(historyButton);
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Loading revision history"));
  expect(document.activeElement).not.toBe(document.body);
  const heading = screen.getByRole("heading", { name: content.name });
  heading.focus();
  resolve({ scope, revisions: [revision] });
  await screen.findByText("Revision history");
  expect(document.activeElement).toBe(heading);
});

it("names deletion and keeps its decision focused while pending and after failure", async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(deletePersonalSkill).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(screen.getByRole("group", { name: "Confirm deletion" }).textContent).toContain(content.name);
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Deleting"));
  expect(document.activeElement).not.toBe(document.body);
  reject(new Error("Delete failed"));
  await screen.findByRole("alert");
  expect(screen.getByRole("group", { name: "Confirm deletion" })).toBeTruthy();
  expect(document.activeElement).not.toBe(document.body);
  expect(deletePersonalSkill).toHaveBeenCalledTimes(1);
});

it("blocks duplicate saves in the same turn and keeps the pending trigger focused", async () => {
  let resolve!: (value: { scope: typeof scope; skill: typeof draft }) => void;
  vi.mocked(createPersonalSkill).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
  const save = screen.getByRole("button", { name: "Save draft" });
  save.focus();
  fireEvent.click(save);
  fireEvent.click(save);
  expect(createPersonalSkill).toHaveBeenCalledTimes(1);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(save);
  resolve({ scope, skill: draft });
  expect(await screen.findByRole("heading", { name: content.name })).toBe(document.activeElement);
});

it("keeps a local Markdown read pending without a service write or a duplicate read", async () => {
  let resolve!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const onDirtyChange = vi.fn();
  render(<PersonalSkills expectedScope={scope} onDirtyChange={onDirtyChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  const input = screen.getByLabelText("Upload SKILL.md");
  input.focus();
  const event = { target: { files: [{ name: "SKILL.md", size: 100, text: read }] } };
  fireEvent.change(input, event);
  fireEvent.change(input, event);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Reading SKILL.md…");
  expect(document.activeElement).toBe(screen.getByRole("status"));
  expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  resolve("sample markdown");
  await waitFor(() => expect((screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement).value).toBe("sample markdown"));
  expect(document.activeElement).toBe(input);
  expect(createPersonalSkill).not.toHaveBeenCalled();
});

it("clears the editor, deletion decision, and history after a scope failure", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  vi.mocked(deletePersonalSkill).mockRejectedValueOnce(scopeError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  await screen.findByText("Revision history");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  await screen.findByRole("button", { name: "Reload page" });
  expect(screen.queryByRole("group", { name: "Confirm deletion" })).toBeNull();
  expect(screen.queryByText(content.name)).toBeNull();
  expect(screen.queryByText("Revision history")).toBeNull();
});

it("keeps the latest-version write block after explicitly cancelling an editor", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] }).mockRejectedValueOnce(new Error("Read unavailable"));
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "My draft." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("button", { name: "Reload latest version" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByRole("button", { name: "Reload latest version" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Turn off" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  expect(deletePersonalSkill).not.toHaveBeenCalled();
});

it("uses one list recovery after leaving a skill whose conflict reread failed", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] })
    .mockRejectedValueOnce(new Error("Read unavailable"));
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "My draft." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("button", { name: "Reload latest version" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
  expect(screen.queryByRole("group", { name: "Reload current skill" })).toBeNull();
  expect(screen.getAllByText("Read unavailable")).toHaveLength(1);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Reload latest version" })).toBeNull();
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] });
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(getPersonalSkills).toHaveBeenCalledTimes(3);
  expect(updatePersonalSkill).toHaveBeenCalledTimes(1);
});

const disabledButton = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
// Edits released revision 1, gets a save conflict, and fails the reread that follows.
async function failRecoveryWhileEditing(text = "My draft.") {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] })
    .mockRejectedValueOnce(new Error("Read unavailable"));
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("button", { name: "Reload latest version" });
}
async function discardAndLeave() {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
  await screen.findByRole("heading", { name: "Private skills" });
}

it("keeps the write block after leaving and reopening a skill whose conflict reread failed", async () => {
  await failRecoveryWhileEditing();
  await discardAndLeave();
  expect(disabledButton("Edit")).toBe(true);
  expect(disabledButton("Create skill")).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Reload skills before you create or change a skill.");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByRole("group", { name: "Reload current skill" })).toBeTruthy();
  expect(disabledButton("Edit")).toBe(true);
  expect(disabledButton("Turn off")).toBe(true);
  expect(disabledButton("Delete")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  expect(actOnPersonalSkill).not.toHaveBeenCalled();
  expect(getPersonalSkills).toHaveBeenCalledTimes(2);
});

it("keeps the write block after a round trip through Share with organization", async () => {
  await failRecoveryWhileEditing();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with organization" }));
  expect((await screen.findByLabelText("Private skill") as HTMLSelectElement).value).toBe("skill-1");
  // The prefilled submission counts as unsent work, so leaving asks first.
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Back to private skills" }));
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockRestore();
  expect(await screen.findByRole("heading", { name: "Private skills" })).toBe(document.activeElement);
  expect(disabledButton("Edit")).toBe(true);
  expect(disabledButton("Create skill")).toBe(true);
  expect(updatePersonalSkill).toHaveBeenCalledTimes(1);
});

it("keeps the write block through a failed list reload and lifts it after a successful one", async () => {
  const newer = { ...released, version: 3 };
  await failRecoveryWhileEditing();
  await discardAndLeave();
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("Still unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  expect(await screen.findByText("Still unavailable")).toBeTruthy();
  expect(disabledButton("Edit")).toBe(true);
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [newer] });
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(disabledButton("Create skill")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(content.instructions);
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Fresh edit." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(updatePersonalSkill).toHaveBeenLastCalledWith("skill-1", { scope, version: 3, source: { kind: "inline", ...content, instructions: "Fresh edit." } }));
});

it("returns to the saved skill, not the discarded draft, after a later successful reread", async () => {
  const newer = { ...released, version: 3, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other text." } } };
  await failRecoveryWhileEditing();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [newer] });
  fireEvent.click(screen.getByRole("button", { name: "Reload latest version" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This skill changed elsewhere");
  expect(screen.queryByRole("group", { name: "Latest saved version" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("Other text.")).toBeTruthy();
  expect(disabledButton("Turn off")).toBe(false);
});

it("shows a skill deleted elsewhere as a list notice after its draft was discarded", async () => {
  await failRecoveryWhileEditing();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [] });
  fireEvent.click(screen.getByRole("button", { name: "Reload latest version" }));
  expect((await screen.findByRole("alert")).textContent).toContain("It is no longer in your list.");
  expect(screen.getByRole("heading", { name: "Private skills" })).toBe(document.activeElement);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(disabledButton("Create skill")).toBe(false);
});

it("keeps edited text through two failed rereads, then offers the choice", async () => {
  const newer = { ...released, version: 3, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other text." } } };
  await failRecoveryWhileEditing("Keep this.");
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("Still unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Reload latest version" }));
  expect(await screen.findByText("Still unavailable")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Reload current skill" })).toBeTruthy();
  expect(disabledButton("Save draft")).toBe(true);
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [newer] });
  fireEvent.click(screen.getByRole("button", { name: "Reload latest version" }));
  expect((await screen.findByRole("group", { name: "Latest saved version" })).textContent).toContain("Other text.");
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep this.");
  expect(disabledButton("Save draft")).toBe(true);
});

it("turns an edited skill deleted elsewhere into a new draft after a retried reread", async () => {
  const onDirtyChange = vi.fn();
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [released] })
    .mockRejectedValueOnce(new Error("Read unavailable")).mockResolvedValueOnce({ scope, skills: [] });
  vi.mocked(updatePersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} onDirtyChange={onDirtyChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep this." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload latest version" }));
  expect(await screen.findByRole("heading", { name: "Create a draft" })).toBe(document.activeElement);
  expect(screen.getByRole("alert").textContent).toContain("Your text is still here.");
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep this.");
  expect(disabledButton("Save draft")).toBe(false);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
});


it.each(["cancel", "save"] as const)("keeps list read recovery after creating a draft then %s", async (outcome) => {
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("List read failed"));
  render(<PersonalSkills expectedScope={scope} />);
  await screen.findByText("List read failed");
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  if (outcome === "save") {
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
    fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to skills" }));
    expect(screen.getByRole("heading", { name: content.name })).toBeTruthy();
    expect(screen.getByText("Could not load the full skills list")).toBeTruthy();
  } else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("List read failed")).toBeTruthy();
  expect(screen.queryByText(/No private skills saved/)).toBeNull();
  const reads = vi.mocked(getPersonalSkills).mock.calls.length;
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: outcome === "save" ? [draft] : [] });
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  await waitFor(() => expect(screen.queryByText("List read failed")).toBeNull());
  expect(getPersonalSkills).toHaveBeenCalledTimes(reads + 1);
  expect(createPersonalSkill).toHaveBeenCalledTimes(outcome === "save" ? 1 : 0);
});

it.each(["save", "release", "disable", "delete"] as const)("preserves focus moved outside the skill during pending %s", async (operation) => {
  let complete!: () => void;
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [operation === "release" ? draft : released] });
  if (operation === "save") vi.mocked(updatePersonalSkill).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ scope, skill: { ...released, version: 3 } }); }));
  else if (operation === "delete") vi.mocked(deletePersonalSkill).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ scope, deleted: true }); }));
  else vi.mocked(actOnPersonalSkill).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ scope, skill: operation === "disable" ? { ...released, version: 3, enabled: false } : released }); }));
  render(<><button>Outside skills</button><PersonalSkills expectedScope={scope} /></>);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  if (operation === "save") {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Changed draft" } });
  } else if (operation === "release") fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  else if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const name = { save: "Save draft", release: "Make revision 1 available", disable: "Turn off", delete: "Delete skill" }[operation];
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("status")).toBeTruthy();
  const outside = screen.getByRole("button", { name: "Outside skills" });
  outside.focus();
  await act(async () => complete());
  expect(document.activeElement).toBe(outside);
  // The pending announcement ends. A success notice can remain.
  expect(screen.queryAllByRole("status").map((node) => node.textContent)).not.toContainEqual(expect.stringMatching(/…$/));
});

// Records which element each scrollIntoView call brings into view.
function trackScrolls() {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true,
    value: function (this: Element) { scrolled.push(this); } });
  return scrolled;
}
afterEach(() => { Reflect.deleteProperty(Element.prototype, "scrollIntoView"); });
const unavailable = () => new Error("Service unavailable.");

it.each([
  ["save", "Draft not saved"],
  ["release", "Could not make revision 1 available"],
  ["disable", "Could not turn off meeting-notes"],
  ["delete", "Could not delete meeting-notes"],
  ["history", "Could not load revision history"]
] as const)("shows a failed %s at its trigger and brings both into view", async (operation, title) => {
  const scrolled = trackScrolls();
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [operation === "release" ? draft : released] });
  if (operation === "save") vi.mocked(updatePersonalSkill).mockRejectedValueOnce(unavailable());
  else if (operation === "delete") vi.mocked(deletePersonalSkill).mockRejectedValueOnce(unavailable());
  else if (operation === "history") vi.mocked(getPersonalSkillHistory).mockRejectedValueOnce(unavailable());
  else vi.mocked(actOnPersonalSkill).mockRejectedValueOnce(unavailable());
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  if (operation === "save") {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Unsaved words" } });
  } else if (operation === "release") fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  else if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const name = { save: "Save draft", release: "Make revision 1 available", disable: "Turn off", delete: "Delete skill", history: "History" }[operation];
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  fireEvent.click(trigger);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(title);
  expect(alert.textContent).toContain("Service unavailable.");
  expect(trigger.getAttribute("aria-describedby")).toBe(alert.id);
  expect(document.activeElement).toBe(trigger);
  // One scroll brings the block with the trigger and its error into view.
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0].contains(trigger) && scrolled[0].contains(alert)).toBe(true);
  if (operation === "save") expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Unsaved words");
  if (operation === "delete") expect(within(screen.getByRole("group", { name: "Confirm deletion" })).getByRole("alert")).toBe(alert);
  if (operation === "release") expect(within(screen.getByRole("group", { name: "Review draft revision 1" })).getByRole("alert")).toBe(alert);
});

it("does not scroll to a failure after focus moves away during the request", async () => {
  const scrolled = trackScrolls();
  let fail!: (reason: Error) => void;
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  vi.mocked(actOnPersonalSkill).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<><button>Outside skills</button><PersonalSkills expectedScope={scope} /></>);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  const trigger = screen.getByRole("button", { name: "Turn off" });
  trigger.focus();
  fireEvent.click(trigger);
  const outside = screen.getByRole("button", { name: "Outside skills" });
  outside.focus();
  await act(async () => fail(unavailable()));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not turn off meeting-notes");
  expect(document.activeElement).toBe(outside);
  expect(scrolled).toHaveLength(0);
});

it("keeps list, import and write errors apart", async () => {
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("List read failed"));
  vi.mocked(createPersonalSkill).mockRejectedValueOnce(unavailable());
  render(<PersonalSkills expectedScope={scope} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load private skills");
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  expect(screen.queryByText("List read failed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.change(screen.getByLabelText("Upload SKILL.md"), { target: { files: [{ name: "notes.txt", size: 10, text: vi.fn() }] } });
  expect((await screen.findByRole("alert")).textContent).toContain("Could not use this file");
  fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md text" }), { target: { value: "notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(screen.getAllByRole("alert").map((node) => node.textContent?.slice(0, 15))).toEqual(["Could not use t", "Draft not saved"]);
  expect(createPersonalSkill).toHaveBeenCalledTimes(1);
});

it("names the draft and active revisions and marks them in a collapsible history", async () => {
  const draftTwo = { ...revision, revision: 2, content: { ...content, instructions: "Write actions." } };
  const skill = { ...released, version: 3, latest: draftTwo };
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [skill] });
  vi.mocked(getPersonalSkillHistory).mockResolvedValue({ scope, revisions: [draftTwo, revision] });
  const scrolled = trackScrolls();
  render(<PersonalSkills expectedScope={scope} />);
  expect(await screen.findByText("Draft revision 2 to review")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Instructions in draft revision 2")).toBeTruthy();
  const history = screen.getByRole("button", { name: "History" });
  expect(history.getAttribute("aria-expanded")).toBe("false");
  history.focus();
  fireEvent.click(history);
  const list = await screen.findByRole("region", { name: "Revision history" });
  expect(history.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(history.getAttribute("aria-controls")!)?.contains(list)).toBe(true);
  expect(list.tabIndex).toBe(0);
  const rows = within(list).getAllByRole("listitem");
  expect(rows[0].textContent).toContain("Latest draft");
  expect(rows[1].textContent).toContain("In use");
  expect(scrolled.some((node) => node.contains(history) && node.contains(list))).toBe(true);
  fireEvent.click(history);
  expect(screen.queryByRole("region", { name: "Revision history" })).toBeNull();
  expect(history.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(history);
  expect(screen.getByRole("region", { name: "Revision history" })).toBeTruthy();
  expect(getPersonalSkillHistory).toHaveBeenCalledTimes(1);
});

it("keeps confirmed skills visible while a reload waits", async () => {
  let finish!: (value: { scope: typeof scope; skills: typeof draft[] }) => void;
  vi.mocked(getPersonalSkills).mockRejectedValueOnce(new Error("List read failed"));
  render(<PersonalSkills expectedScope={scope} />);
  await screen.findByText("List read failed");
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: content.instructions } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Back to skills" }));
  vi.mocked(getPersonalSkills).mockImplementationOnce(() => new Promise(done => { finish = done; }));
  fireEvent.click(screen.getByRole("button", { name: "Reload skills" }));
  expect(screen.getByRole("heading", { name: content.name })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Reloading skills");
  await act(async () => finish({ scope, skills: [draft] }));
  expect(screen.getByRole("heading", { name: content.name })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears a success message when the view changes", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [draft] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed revision 1 / }));
  fireEvent.click(screen.getByRole("button", { name: "Make revision 1 available" }));
  expect(await screen.findByText("meeting-notes is available for your chats.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.queryByText(/is in use$/)).toBeNull();
});

it("explains Turn off before it runs and does not name an active revision when creating", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  expect(screen.getByText(/Turn off makes this skill unavailable for your chats\. Revision 1 stays saved/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByText("Saving creates a new draft. Revision 1 stays in use until you release the draft.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  expect(screen.getByText(/Saving a draft does not make it available in chats/)).toBeTruthy();
  expect(screen.queryByText(/stays in use|active revision/)).toBeNull();
});

it("names the initial read while no confirmed skills are available", () => {
  vi.mocked(getPersonalSkills).mockReturnValue(new Promise(() => {}));
  render(<PersonalSkills expectedScope={scope} />);
  expect(screen.getByRole("status").textContent).toBe("Loading private skills…");
  expect(screen.queryByText(/No private skills saved/)).toBeNull();
});

it("keeps text after a cancelled source switch and discards only after confirmation", async () => {
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Private unsaved text" } });
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  const decision = screen.getByRole("alertdialog", { name: "Discard unsaved skill changes?" });
  expect(decision.textContent).toContain("Switching the source removes the text you entered.");
  fireEvent.click(within(decision).getByRole("button", { name: "Keep editing" }));
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Private unsaved text");
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect((screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(createPersonalSkill).not.toHaveBeenCalled();
});

it("explains the removal of text after a scope lock", async () => {
  vi.mocked(createPersonalSkill).mockRejectedValueOnce(scopeError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: content.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), { target: { value: content.description } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Private scope text" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Unsaved text was cleared to protect your private skills.");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText("Private scope text")).toBeNull();
});
