import { describe, expect, it } from "vitest";
import type { PersonalSkill, ProjectSkill } from "@cogniplane/shared-types";
import {
  canOpenEdit, conflictSkill, initialProjectSkillEditorState, isDirty, isReviewed, projectSkillEditorReducer,
  selectedSkill, type ProjectSkillEditorEvent, type ProjectSkillEditorState
} from "./project-skills.logic";

const date = "2026-09-26T12:00:00.000Z";
const content = { name: "meeting-notes", description: "Write meeting notes", instructions: "List decisions." };
const revision = { revision: 1, content, validationMessages: [], createdAt: date, copiedFromRevision: null };
const skillA: ProjectSkill = { id: "skill-a", version: 1, enabled: false, latest: revision, active: null, copiedFrom: null, updatedAt: date };
const skillB: ProjectSkill = { ...skillA, id: "skill-b", latest: { ...revision, content: { ...content, name: "status-report" } } };
const privateSkill: PersonalSkill = { id: "personal-a", version: 3, enabled: true,
  latest: { ...revision, revision: 2 }, active: { ...revision, revision: 1 }, updatedAt: date };
const otherPrivateSkill: PersonalSkill = { ...privateSkill, id: "personal-b" };

function apply(state: ProjectSkillEditorState, ...events: ProjectSkillEditorEvent[]) {
  return events.reduce(projectSkillEditorReducer, state);
}
function loaded(skills: ProjectSkill[] = [skillA, skillB]) {
  return apply(initialProjectSkillEditorState(),
    { type: "listReadAccepted", origin: "effect", skills, canEdit: true }, { type: "listReadFinished" });
}
const typed = (state: ProjectSkillEditorState, instructions: string) => apply(state,
  { type: "draftChanged", editor: { kind: "inline", content: { ...content, instructions } } });
const editingA = () => typed(apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "editOpened", skillId: "skill-a" }), "My text");
const reloaded = (skills: ProjectSkill[]): ProjectSkillEditorEvent => ({ type: "listReadAccepted", origin: "reload", skills, canEdit: true });
const conflictInEdit = () => apply(editingA(), { type: "operationStarted", operation: "save" }, { type: "recoveryRequired" });

describe("view and draft transitions", () => {
  it("opens a create draft with an empty inline baseline and clears earlier feedback", () => {
    const state = apply(loaded(), { type: "operationFailed", message: "Old error" }, { type: "createOpened" });
    expect(state.view).toEqual({ kind: "create", draft: { editor: { kind: "inline", content: { name: "", description: "", instructions: "" } },
      baseline: JSON.stringify({ kind: "inline", content: { name: "", description: "", instructions: "" } }) } });
    expect(state.feedback.error).toBeNull();
    expect(isDirty(state.view)).toBe(false);
    expect(isDirty(typed(state, "Text").view)).toBe(true);
  });

  it("ignores navigation events that do not belong to the current screen", () => {
    const create = apply(loaded(), { type: "createOpened" });
    expect(projectSkillEditorReducer(create, { type: "createOpened" })).toBe(create);
    expect(projectSkillEditorReducer(create, { type: "detailsOpened", skillId: "skill-a" })).toBe(create);
    expect(projectSkillEditorReducer(create, { type: "listOpened" })).toBe(create);
    expect(projectSkillEditorReducer(create, { type: "deleteConfirmationChanged", open: true })).toBe(create);
    const list = loaded();
    expect(projectSkillEditorReducer(list, { type: "cancelled" })).toBe(list);
    expect(projectSkillEditorReducer(list, { type: "draftChanged", editor: { kind: "markdown", markdown: "x" } })).toBe(list);
    const detailsA = apply(list, { type: "detailsOpened", skillId: "skill-a" });
    expect(projectSkillEditorReducer(detailsA, { type: "editOpened", skillId: "skill-b" })).toBe(detailsA);
  });

  it("switches the source to an empty baseline and treats the current source as a no-op", () => {
    const state = typed(apply(loaded(), { type: "createOpened" }), "Text");
    expect(projectSkillEditorReducer(state, { type: "sourceSwitched", kind: "inline" })).toBe(state);
    const markdown = apply(state, { type: "fileReadFailed", message: "Bad file" }, { type: "sourceSwitched", kind: "markdown" });
    expect(markdown.view).toMatchObject({ kind: "create", draft: { editor: { kind: "markdown", markdown: "" }, baseline: JSON.stringify({ kind: "markdown", markdown: "" }) } });
    expect(markdown.feedback.fileError).toBeNull();
  });

  it("returns an edit to details and a create to the list on cancel", () => {
    expect(apply(editingA(), { type: "cancelled" }).view).toEqual({ kind: "details", skillId: "skill-a", sourceCandidate: null, confirmDelete: false });
    expect(apply(loaded(), { type: "createOpened" }, { type: "cancelled" }).view).toEqual({ kind: "list" });
  });

  it("keeps the selected ID when a reload removes its row", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "accessChanged" }, reloaded([skillB]));
    expect(state.view).toMatchObject({ kind: "details", skillId: "skill-a" });
    expect(selectedSkill(state)).toBeNull();
  });
});

describe("reviews", () => {
  it("keeps one review at a time and compares the exact identity", () => {
    const copied: ProjectSkill = { ...skillA, copiedFrom: { mine: true, personalSkillId: privateSkill.id, revision: 1 } };
    let state = apply(loaded([copied]), { type: "detailsOpened", skillId: "skill-a" }, { type: "sourceRequested" },
      { type: "sourceLoaded", skill: privateSkill }, { type: "reviewChanged", kind: "release", checked: true });
    expect([isReviewed(state, "release"), isReviewed(state, "source-update")]).toEqual([true, false]);
    state = apply(state, { type: "reviewChanged", kind: "source-update", checked: true });
    expect([isReviewed(state, "release"), isReviewed(state, "source-update")]).toEqual([false, true]);
    expect(state.review).toEqual({ kind: "source-update", skillId: "skill-a", sourceRevision: 1, version: 1 });
    // A mount-effect read can change the version without clearing the stored review.
    state = apply(state, { type: "listReadAccepted", origin: "effect", skills: [{ ...copied, version: 2 }], canEdit: true });
    expect(state.review).not.toBeNull();
    expect(isReviewed(state, "source-update")).toBe(false);
    expect(apply(state, { type: "reviewChanged", kind: "release", checked: false }).review).toBeNull();
  });

  it("does not store a review that the current screen cannot show", () => {
    const list = loaded();
    expect(projectSkillEditorReducer(list, { type: "reviewChanged", kind: "release", checked: true })).toBe(list);
    const copy = apply(list, { type: "copyListLoaded", skills: [privateSkill] });
    expect(projectSkillEditorReducer(copy, { type: "reviewChanged", kind: "copy", checked: true })).toBe(copy);
    expect(projectSkillEditorReducer(list, { type: "reviewChanged", kind: "copy", checked: false })).toBe(list);
  });

  it("clears the copy review when another candidate is requested, even at the same revision", () => {
    let state = apply(loaded(), { type: "copyListLoaded", skills: [privateSkill, otherPrivateSkill, { ...privateSkill, id: "off", enabled: false }] });
    expect(state.personal.map(skill => skill.id)).toEqual(["personal-a", "personal-b"]);
    state = apply(state, { type: "copyCandidateRequested" }, { type: "copyCandidateLoaded", skill: privateSkill },
      { type: "reviewChanged", kind: "copy", checked: true });
    expect(isReviewed(state, "copy")).toBe(true);
    state = apply(state, { type: "copyCandidateRequested" });
    expect(state.view).toEqual({ kind: "copy", candidate: null });
    expect(state.review).toBeNull();
    state = apply(state, { type: "copyCandidateLoaded", skill: otherPrivateSkill });
    expect(isReviewed(state, "copy")).toBe(false);
  });

  it("reports a candidate that is no longer released without showing it", () => {
    const copy = apply(loaded(), { type: "copyListLoaded", skills: [] }, { type: "copyCandidateLoaded", skill: { ...privateSkill, active: null } });
    expect(copy.view).toEqual({ kind: "copy", candidate: null });
    expect(copy.feedback.error).toBe("This private skill is no longer released. Reload the private library.");
    const detailsView = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "sourceLoaded", skill: { ...privateSkill, enabled: false } });
    expect(detailsView.view).toMatchObject({ sourceCandidate: null });
    expect(detailsView.feedback.error).toBe("Your private source is no longer released.");
  });
});

describe("results", () => {
  it("replaces a saved skill, sorts by name, and opens its details", () => {
    const created: ProjectSkill = { ...skillA, id: "skill-c", latest: { ...revision, revision: 4, content: { ...content, name: "action-items" } } };
    const state = apply(loaded(), { type: "createOpened" }, { type: "skillSaved", skill: created });
    expect(state.list.skills.map(skill => skill.id)).toEqual(["skill-c", "skill-a", "skill-b"]);
    expect(state.view).toEqual({ kind: "details", skillId: "skill-c", sourceCandidate: null, confirmDelete: false });
    expect(state.feedback.notice).toBe("Draft revision 4 saved. Release is a separate action.");
  });

  it("clears history and review after a release, although the ID is unchanged", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" },
      { type: "historyLoaded", skillId: "skill-a", revisions: [revision] }, { type: "deleteConfirmationChanged", open: true },
      { type: "reviewChanged", kind: "release", checked: true },
      { type: "skillActionSucceeded", action: "release", skill: { ...skillA, version: 2, enabled: true, active: revision }, projectName: "Planning" });
    expect(state.history).toBeNull();
    expect(state.review).toBeNull();
    expect(state.view).toMatchObject({ confirmDelete: false });
    expect(state.feedback.notice).toBe("Revision 1 released in Planning. It applies on the next turn when selected.");
  });

  it("keeps an open delete confirmation after a source update, as the editor does today", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "deleteConfirmationChanged", open: true },
      { type: "sourceUpdated", skill: { ...skillA, version: 2, latest: { ...revision, revision: 2 } }, sourceRevision: 3 });
    expect(state.view).toMatchObject({ confirmDelete: true, sourceCandidate: null });
    expect(state.feedback.notice).toBe("Private revision 3 copied into draft revision 2. Release is a separate action.");
  });

  it("ignores results for another skill or another screen", () => {
    const detailsA = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" });
    for (const event of [
      { type: "skillActionSucceeded", action: "disable", skill: skillB, projectName: "Planning" },
      { type: "sourceUpdated", skill: skillB, sourceRevision: 1 },
      { type: "skillDeleted", skillId: "skill-b" },
      { type: "historyLoaded", skillId: "skill-b", revisions: [] },
      { type: "skillSaved", skill: skillA },
      { type: "skillCopied", skill: skillA },
      { type: "copyCandidateLoaded", skill: privateSkill },
      { type: "localTextKept" },
      { type: "latestVersionChosen" }
    ] satisfies ProjectSkillEditorEvent[]) expect(projectSkillEditorReducer(detailsA, event)).toBe(detailsA);
  });

  it("removes a deleted skill and returns to the list", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "skillDeleted", skillId: "skill-a" });
    expect(state.view).toEqual({ kind: "list" });
    expect(state.list.skills.map(skill => skill.id)).toEqual(["skill-b"]);
  });
});

describe("list reads and recovery", () => {
  it("accepts a mount-effect list read without clearing history, review, candidates, errors or recovery", () => {
    const copied: ProjectSkill = { ...skillA, copiedFrom: { mine: true, personalSkillId: privateSkill.id, revision: 1 } };
    const before = apply(loaded([copied]), { type: "detailsOpened", skillId: "skill-a" },
      { type: "historyLoaded", skillId: "skill-a", revisions: [revision] }, { type: "sourceLoaded", skill: privateSkill },
      { type: "reviewChanged", kind: "release", checked: true }, { type: "operationFailed", message: "Kept" }, { type: "listReadFailed" });
    const after = apply(before, { type: "listReadAccepted", origin: "effect", skills: [copied], canEdit: false });
    expect(after.list).toMatchObject({ canEdit: false, readFailed: false });
    expect([after.history, after.review, after.feedback.error]).toEqual([before.history, before.review, "Kept"]);
    expect(after.view).toBe(before.view);
  });

  it("clears history, review, source candidate and error after a reload of an unchanged list", () => {
    const copied: ProjectSkill = { ...skillA, copiedFrom: { mine: true, personalSkillId: privateSkill.id, revision: 1 } };
    const state = apply(loaded([copied]), { type: "detailsOpened", skillId: "skill-a" },
      { type: "historyLoaded", skillId: "skill-a", revisions: [revision] }, { type: "sourceLoaded", skill: privateSkill },
      { type: "reviewChanged", kind: "release", checked: true }, { type: "operationFailed", message: "Old" }, reloaded([copied]));
    expect([state.history, state.review, state.feedback.error]).toEqual([null, null, null]);
    expect(state.view).toMatchObject({ kind: "details", skillId: "skill-a", sourceCandidate: null });
  });

  it("sets the read block and records the edited skill when recovery starts", () => {
    const state = conflictInEdit();
    expect(state.list.readFailed).toBe(true);
    expect(state.recovery).toEqual({ kind: "awaiting-list", skillId: "skill-a", editing: true });
    expect(state.request.pending).toBe("save");
    expect(canOpenEdit(state)).toBe(false);
  });

  it("clears candidates and the delete confirmation and records a non-editing target in details", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "sourceLoaded", skill: privateSkill },
      { type: "deleteConfirmationChanged", open: true }, { type: "reviewChanged", kind: "release", checked: true }, { type: "recoveryRequired" });
    expect(state.view).toEqual({ kind: "details", skillId: "skill-a", sourceCandidate: null, confirmDelete: false });
    expect(state.review).toBeNull();
    expect(state.recovery).toEqual({ kind: "awaiting-list", skillId: "skill-a", editing: false });
  });

  it("records no target without a selected skill and keeps the copy-review message for later", () => {
    const state = apply(loaded(), { type: "copyListLoaded", skills: [privateSkill] }, { type: "copyCandidateLoaded", skill: privateSkill },
      { type: "recoveryRequired" }, reloaded([skillA]), { type: "recoveryFinishedWithoutTarget", message: "Missing." });
    expect(state.recovery).toEqual({ kind: "none" });
    expect(state.view).toEqual({ kind: "copy", candidate: null });
    expect(state.feedback.error).toBe("Missing. Review the source again before trying to copy.");
  });

  it("requires a version choice when the edited skill still exists, then lets Use the latest version reset the draft", () => {
    const latest: ProjectSkill = { ...skillA, version: 2, latest: { ...revision, revision: 2, content: { ...content, instructions: "Theirs" } } };
    const choice = apply(conflictInEdit(), reloaded([latest, skillB]));
    expect(choice.recovery).toEqual({ kind: "awaiting-version-choice", skillId: "skill-a" });
    expect(conflictSkill(choice)).toBe(latest);
    expect(choice.feedback.error).toBe("Project skills were reloaded. Review the current revision before trying again. Your unsaved text is still here.");
    expect(canOpenEdit(choice)).toBe(true);
    const latestChosen = apply(choice, { type: "latestVersionChosen" });
    expect(latestChosen.recovery).toEqual({ kind: "none" });
    expect(latestChosen.view).toMatchObject({ kind: "edit", draft: { editor: { kind: "inline", content: latest.latest.content } } });
    expect(isDirty(latestChosen.view)).toBe(false);
    expect(latestChosen.feedback.error).toBeNull();
  });

  it("keeps the local text and its baseline when the person keeps their text", () => {
    const choice = apply(conflictInEdit(), reloaded([{ ...skillA, version: 2 }]));
    const kept = apply(choice, { type: "localTextKept" });
    expect(kept.recovery).toEqual({ kind: "none" });
    expect(kept.view).toEqual(choice.view);
    expect(isDirty(kept.view)).toBe(true);
    expect(kept.feedback.error).toBeNull();
  });

  it("turns a deleted edited skill into a create draft that keeps its text and baseline", () => {
    const before = conflictInEdit();
    const state = apply(before, reloaded([skillB]));
    expect(state.view).toEqual({ kind: "create", draft: before.view.kind === "edit" ? before.view.draft : null });
    expect(state.feedback.notice).toBe("This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel.");
    expect(state.recovery).toEqual({ kind: "none" });
  });

  it("marks recovery as not editing on cancel, keeps the read block, and keeps the target through Back and Details", () => {
    const failed = apply(conflictInEdit(), { type: "listReadFailed" }, { type: "operationFailed", message: "Read unavailable" },
      { type: "operationFinished", operation: "save" });
    const cancelled = apply(failed, { type: "cancelled" });
    expect(cancelled.recovery).toEqual({ kind: "awaiting-list", skillId: "skill-a", editing: false });
    expect(cancelled.list.readFailed).toBe(true);
    expect(cancelled.feedback.error).toBeNull();
    expect(projectSkillEditorReducer(cancelled, { type: "editOpened", skillId: "skill-a" })).toBe(cancelled);
    // Another skill is open when the reload finds the original target missing.
    const elsewhere = apply(cancelled, { type: "listOpened" }, { type: "detailsOpened", skillId: "skill-b" });
    expect(elsewhere.recovery).toEqual(cancelled.recovery);
    const state = apply(elsewhere, reloaded([skillB]));
    expect(state.view).toEqual({ kind: "list" });
    expect(state.feedback.notice).toBe("This skill was deleted elsewhere. It is no longer in this project.");
  });

  it("does not reopen a cancelled edit when the target still exists", () => {
    const state = apply(conflictInEdit(), { type: "listReadFailed" }, { type: "operationFinished", operation: "save" },
      { type: "cancelled" }, reloaded([skillA, skillB]));
    expect(state.view).toEqual({ kind: "details", skillId: "skill-a", sourceCandidate: null, confirmDelete: false });
    expect(state.recovery).toEqual({ kind: "none" });
    expect(state.feedback.error).toBe("Project skills were reloaded. Review the current revision before trying again.");
  });

  it("restores saved text with a clean baseline when unresolved recovery later finds its target missing", () => {
    // Only a mount-effect read that skips reconciliation can leave this combination.
    const saved = apply(conflictInEdit(), { type: "listReadAccepted", origin: "effect", skills: [skillA], canEdit: true },
      { type: "operationFinished", operation: "save" }, { type: "operationStarted", operation: "save" },
      { type: "skillSaved", skill: skillA });
    expect(saved.recovery).toMatchObject({ kind: "awaiting-list", editing: true });
    const state = apply(saved, reloaded([skillB]));
    const editor = { kind: "inline", content: { ...content, instructions: "My text" } };
    expect(state.view).toEqual({ kind: "create", draft: { editor, baseline: JSON.stringify(editor) } });
    expect(isDirty(state.view)).toBe(false);
    expect(state.recovery).toEqual({ kind: "none" });
    expect(state.feedback.notice).toBe("This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel.");
  });

  it("sets the load location for Reload skills only without an awaiting-list target", () => {
    const started = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "operationStarted", operation: "history" });
    expect(apply(started, { type: "reloadRequested" }).feedback.errorAt).toBe("load");
    const recovering = apply(started, { type: "recoveryRequired" });
    expect(projectSkillEditorReducer(recovering, { type: "reloadRequested" })).toBe(recovering);
  });
});

describe("requests, files and access", () => {
  it("records one pending operation and clears it only for the same operation", () => {
    const started = apply(loaded(), { type: "operationFailed", message: "Old" }, { type: "operationStarted", operation: "save" });
    expect(started.request.pending).toBe("save");
    expect(started.feedback).toMatchObject({ errorAt: "save", error: null, notice: null });
    expect(projectSkillEditorReducer(started, { type: "operationStarted", operation: "history" })).toBe(started);
    expect(projectSkillEditorReducer(started, { type: "operationFinished", operation: "history" })).toBe(started);
    expect(apply(started, { type: "operationFinished", operation: "save" }).request.pending).toBeNull();
  });

  it("removes edit access after a refusal", () => {
    expect(apply(loaded(), { type: "accessRefused" }).list.canEdit).toBe(false);
  });

  it("puts a file's text in the draft without changing its baseline", () => {
    const create = apply(loaded(), { type: "createOpened" }, { type: "sourceSwitched", kind: "markdown" }, { type: "fileReadStarted" });
    expect(create.request.readingFile).toBe(true);
    const read = apply(create, { type: "fileReadSucceeded", markdown: "---\nname: notes\n---" }, { type: "fileReadFinished" });
    expect(read.view).toMatchObject({ draft: { editor: { kind: "markdown", markdown: "---\nname: notes\n---" } } });
    expect(isDirty(read.view)).toBe(true);
    expect(read.request.readingFile).toBe(false);
    expect(apply(create, { type: "fileReadFailed", message: "Choose a Markdown (.md) file." }).feedback.fileError).toBe("Choose a Markdown (.md) file.");
    const list = loaded();
    expect(projectSkillEditorReducer(list, { type: "fileReadSucceeded", markdown: "x" })).toBe(list);
  });

  it("drops pending work and review on an access change but keeps history and the draft", () => {
    const state = apply(editingA(), { type: "operationStarted", operation: "save" }, { type: "fileReadStarted" }, { type: "accessChanged" });
    expect(state.request).toEqual({ pending: null, readingFile: false });
    expect(state.view).toEqual(editingA().view);
    const detailsView = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "historyLoaded", skillId: "skill-a", revisions: [revision] },
      { type: "reviewChanged", kind: "release", checked: true }, { type: "accessChanged" });
    expect(detailsView.review).toBeNull();
    expect(detailsView.history).not.toBeNull();
  });

  it("clears history and every error when history closes", () => {
    const state = apply(loaded(), { type: "detailsOpened", skillId: "skill-a" }, { type: "historyLoaded", skillId: "skill-a", revisions: [revision] },
      { type: "operationFailed", message: "Turn off failed" }, { type: "historyClosed" });
    expect([state.history, state.feedback.error]).toEqual([null, null]);
  });

  it("drops all sensitive state on a scope lock and ignores every later event", () => {
    const state = apply(conflictInEdit(), { type: "copyListLoaded", skills: [privateSkill] }, { type: "scopeLocked", expired: true });
    expect(state).toEqual({ ...initialProjectSkillEditorState(), lock: { locked: true, expired: true },
      list: { skills: [], canEdit: false, loading: false, readFailed: false } });
    expect(projectSkillEditorReducer(state, reloaded([skillA]))).toBe(state);
    expect(projectSkillEditorReducer(state, { type: "createOpened" })).toBe(state);
  });

  it("returns the same state for an unknown event", () => {
    const state = loaded();
    expect(projectSkillEditorReducer(state, { type: "unknown" } as unknown as ProjectSkillEditorEvent)).toBe(state);
  });
});
