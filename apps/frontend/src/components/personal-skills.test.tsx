// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import {
  actOnPersonalSkill, createPersonalSkill, deletePersonalSkill, getPersonalSkillHistory,
  getPersonalSkills, updatePersonalSkill
} from "@/lib/personal-skills-api";
import { PersonalSkills } from "./personal-skills";

vi.mock("@/lib/personal-skills-api", () => ({
  actOnPersonalSkill: vi.fn(), createPersonalSkill: vi.fn(), deletePersonalSkill: vi.fn(),
  getPersonalSkillHistory: vi.fn(), getPersonalSkills: vi.fn(), updatePersonalSkill: vi.fn()
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
  expect(await screen.findByText("Instructions to review")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Make available for my chats" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this revision and its validation messages." }));
  fireEvent.click(screen.getByRole("button", { name: "Make available for my chats" }));
  await waitFor(() => expect(actOnPersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 1, action: "release" }));
  expect(await screen.findByText("Available only to me · Revision 1")).toBeTruthy();
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
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Invalid SKILL.md");
  expect((screen.getByRole("textbox", { name: "SKILL.md text" }) as HTMLTextAreaElement).value).toBe("bad markdown");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Companion files are not saved.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this revision/ }));
  expect((screen.getByRole("button", { name: "Make available for my chats" }) as HTMLButtonElement).disabled).toBe(false);
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
  expect(await screen.findByText("Your current chats still use revision 1 while this draft waits for review.")).toBeTruthy();
});

it("keeps an edit through a conflict and requires a fresh review before release", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [draft] }).mockResolvedValueOnce({ scope, skills: [{ ...draft, version: 2 }] });
  vi.mocked(actOnPersonalSkill).mockRejectedValueOnce(conflictError);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this revision/ }));
  fireEvent.click(screen.getByRole("button", { name: "Make available for my chats" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Conflict Review the current version"));
  expect((screen.getByRole("button", { name: "Make available for my chats" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this revision/ }));
  fireEvent.click(screen.getByRole("button", { name: "Make available for my chats" }));
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
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this revision/ }));
  fireEvent.click(screen.getByRole("button", { name: "Make available for my chats" }));
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
  expect(await screen.findByText(/Revision 1 · meeting-notes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(deletePersonalSkill).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  await waitFor(() => expect(deletePersonalSkill).toHaveBeenCalledWith("skill-1", { scope, version: 2 }));
  expect(await screen.findByText(/No private skills yet/)).toBeTruthy();
});

it("does not show a deleted skill's history while reviewing a new imported skill", async () => {
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope, skills: [released] });
  vi.mocked(createPersonalSkill).mockResolvedValue({ scope, skill: {
    ...draft, id: "skill-2", latest: { ...revision, content: { ...content, name: "imported-notes" } }
  } });
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(await screen.findByText(/Revision 1 · meeting-notes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md text" }), { target: { value: "---\nname: imported-notes\ndescription: Imported\n---\n\nWrite notes." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Instructions to review")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "imported-notes" })).toBeTruthy();
  expect(screen.queryByText("Revision history")).toBeNull();
  expect(screen.queryByText(/Revision 1 · meeting-notes/)).toBeNull();
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
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "You have reached the private skill limit.");
  expect(getPersonalSkills).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(content.instructions);
});

it("can cancel an unsaved create draft", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onDirtyChange = vi.fn();
  render(<PersonalSkills expectedScope={scope} onDirtyChange={onDirtyChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "draft" } });
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText(/No private skills yet/)).toBeTruthy();
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
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<PersonalSkills expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledWith("Discard your unsaved skill changes?");
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("unsaved");
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Private skills" }));
  confirm.mockRestore();
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
  expect(await screen.findByText("Off · Revision 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this revision/ }));
  fireEvent.click(screen.getByRole("button", { name: "Make available for my chats" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Your saved skill selection is full. Remove a skill from Chat defaults first.");
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
