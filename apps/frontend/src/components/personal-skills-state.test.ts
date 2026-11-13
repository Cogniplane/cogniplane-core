import { describe, expect, it } from "vitest";
import type { PersonalSkill } from "@cogniplane/shared-types";
import {
  hasConflict, initialState, isDirty, isReviewed, personalSkillsReducer as reduce, selectedSkill,
  type ActiveState, type ListRead, type PersonalSkillsEvent, type PersonalSkillsState
} from "./personal-skills-state";

const content = { name: "meeting-notes", description: "Prepare meeting notes", instructions: "Summarize decisions." };
const revision = { revision: 1, content, validationMessages: [], createdAt: "2026-09-26T12:00:00.000Z" };
const released: PersonalSkill = { id: "skill-1", version: 2, enabled: true, latest: revision, active: revision, updatedAt: revision.createdAt };
const newer: PersonalSkill = { ...released, version: 3, latest: { ...revision, revision: 2, content: { ...content, instructions: "Other text." } } };
const other: PersonalSkill = { ...released, id: "skill-2", latest: { ...revision, content: { ...content, name: "other-skill" } } };
const draft: PersonalSkill = { ...released, version: 1, enabled: false, active: null };

const run = (state: PersonalSkillsState, ...events: PersonalSkillsEvent[]) => events.reduce(reduce, state);
function active(state: PersonalSkillsState): ActiveState {
  if (state.status !== "active") throw new Error("Expected an active state");
  return state;
}
const loaded = (skills: PersonalSkill[], read: ListRead = "recovery", focusHere = true): PersonalSkillsEvent =>
  ({ type: "listLoaded", skills, read, focusHere });
const ready = (skills = [released]) => active(run(initialState(false), loaded(skills, "initial", false)));
const typed = (instructions: string): PersonalSkillsEvent => ({ type: "editorChanged", editor: { kind: "inline", content: { ...content, instructions } } });
const discardEdit: PersonalSkillsEvent[] = [{ type: "cancelEditor" }, { type: "discardConfirmed" }];

/** Edits skill-1, gets a save conflict, and fails the automatic reread. */
function failedRecovery(skills = [released]) {
  return active(run(ready(skills),
    { type: "openEdit", skillId: "skill-1" }, typed("My text."),
    { type: "requestStarted", operation: "save" },
    { type: "writeConflicted", skillId: "skill-1", reason: "This skill changed.", focusHere: true },
    { type: "listStarted" }, { type: "listFailed", error: "Read unavailable" },
    { type: "requestFinished" }));
}
const retry = (state: ActiveState, result: PersonalSkillsEvent) => active(run(state,
  { type: "requestStarted", operation: "latest" }, { type: "listStarted" }, result, { type: "requestFinished" }));

describe("recovery after a write conflict", () => {
  it("keeps the text and the block through failed rereads, then asks which version to keep", () => {
    let state = failedRecovery();
    expect(state.recovery).toEqual({ skillId: "skill-1", reason: "This skill changed." });
    expect(state.list).toEqual({ loading: false, error: "Read unavailable" });
    expect(state.focus).toEqual({ target: "recovery" });
    state = retry(state, { type: "listFailed", error: "Still unavailable" });
    expect(state.recovery).not.toBeNull();
    // The save version stays the one the text is based on.
    expect(state.view).toMatchObject({ kind: "edit", version: 2, editor: { content: { instructions: "My text." } } });
    state = retry(state, loaded([newer]));
    expect(state.recovery).toBeNull();
    expect(hasConflict(state)).toBe(true);
    expect(state.focus).toEqual({ target: "conflict" });
    state = active(reduce(state, { type: "keepMyText" }));
    expect(hasConflict(state)).toBe(false);
    expect(state.view).toMatchObject({ kind: "edit", version: 3, editor: { content: { instructions: "My text." } } });
    expect(isDirty(state.view)).toBe(true);
  });

  it("takes the latest version as a clean draft", () => {
    const state = active(run(failedRecovery(), loaded([newer]), { type: "useLatest" }));
    expect(state.view).toMatchObject({ kind: "edit", version: 3, editor: { content: { instructions: "Other text." } } });
    expect(isDirty(state.view)).toBe(false);
    expect(hasConflict(state)).toBe(false);
  });

  it("compares kept text with the accepted server version instead of the original version", () => {
    const kept = active(run(failedRecovery(), loaded([newer]), { type: "keepMyText" }));
    const restored = active(reduce(kept, typed(content.instructions)));
    expect(restored.view).toMatchObject({ kind: "edit", version: 3 });
    expect(isDirty(restored.view)).toBe(true);
    expect(active(reduce(restored, { type: "cancelEditor" })).view).toMatchObject({ discard: "cancel" });
    const matching = active(reduce(kept, typed(newer.latest.content.instructions)));
    expect(isDirty(matching.view)).toBe(false);
  });

  it("keeps the block through every navigation and refuses a stale edit or a new draft", () => {
    let state = active(reduce(failedRecovery(), { type: "cancelEditor" }));
    expect(state.view).toMatchObject({ kind: "edit", discard: "cancel" });
    state = active(reduce(state, { type: "discardConfirmed" }));
    expect(state.view).toMatchObject({ kind: "details", skillId: "skill-1" });
    const exits: PersonalSkillsEvent[] = [
      { type: "openList" }, { type: "openSkill", skillId: "skill-1", kind: "details" },
      { type: "openSubmissions", sourceSkillId: "skill-1" }, { type: "openList" }
    ];
    for (const event of exits) {
      state = active(reduce(state, event));
      expect(state.recovery?.skillId).toBe("skill-1");
    }
    expect(reduce(state, { type: "openEdit", skillId: "skill-1" })).toBe(state);
    expect(reduce(state, { type: "openCreate" })).toBe(state);
  });

  it("ends with a successful Reload skills in the list, without a notice", () => {
    const state = active(run(failedRecovery(), ...discardEdit, { type: "openList" },
      { type: "listStarted" }, { type: "listFailed", error: "Still unavailable" }, { type: "listStarted" }, loaded([newer], "list")));
    expect(state.recovery).toBeNull();
    expect(state.view).toEqual({ kind: "list", notice: null });
    expect(state.list).toEqual({ loading: false, error: null });
    expect(state.focus).toEqual({ target: "heading" });
    expect(active(reduce(state, { type: "openEdit", skillId: "skill-1" })).view).toMatchObject({ kind: "edit", version: 3 });
  });

  it("shows the changed skill, not the discarded draft, after a later reread", () => {
    const state = active(run(failedRecovery(), ...discardEdit, loaded([newer])));
    expect(state.view).toMatchObject({ kind: "details", skillId: "skill-1", notice: {
      title: "This skill changed elsewhere", detail: "This skill changed. Review the current version before you try again."
    } });
    expect(hasConflict(state)).toBe(false);
  });

  it("turns an open editor of a deleted skill into a new draft, and returns a discarded one to the list", () => {
    const editing = active(reduce(failedRecovery(), loaded([])));
    expect(editing.view).toMatchObject({ kind: "create", editor: { content: { instructions: "My text." } }, notice: { title: "This skill was deleted elsewhere" } });
    // The text has no saved counterpart any more, so it counts as unsaved.
    expect(isDirty(editing.view)).toBe(true);
    expect(editing.focus).toEqual({ target: "heading" });
    const discarded = active(run(failedRecovery(), ...discardEdit, loaded([])));
    expect(discarded.view).toEqual({ kind: "list", notice: expect.objectContaining({ detail: "It is no longer in your list." }) });
  });

  it("adds no notice to another skill when the recovered skill reloads", () => {
    const state = active(run(failedRecovery([released, other]), ...discardEdit, { type: "openList" },
      { type: "openSkill", skillId: "skill-2", kind: "details" }, loaded([newer, other])));
    expect(state.recovery).toBeNull();
    expect(state.view).toMatchObject({ kind: "details", skillId: "skill-2", notice: null });
  });

  it("keeps focus where the member moved it", () => {
    const before = failedRecovery();
    const state = retry(before, loaded([newer], "recovery", false));
    expect(hasConflict(state)).toBe(true);
    expect(state.focus).toBe(before.focus);
  });
});

describe("release review", () => {
  const reviewed = () => active(run(ready([draft]), { type: "openSkill", skillId: "skill-1", kind: "review" }, { type: "reviewMarked", reviewed: true }));

  it("binds the review to the skill version, also when the revision stays the same", () => {
    expect(isReviewed(reviewed())).toBe(true);
    expect(isReviewed(active(reduce(reviewed(), loaded([{ ...draft, version: 2 }], "list", false))))).toBe(false);
  });

  it("resets the review after a conflict, navigation or a successful write", () => {
    expect(isReviewed(active(reduce(reviewed(), { type: "writeConflicted", skillId: "skill-1", reason: "Conflict", focusHere: false })))).toBe(false);
    expect(isReviewed(active(run(reviewed(), { type: "openList" }, { type: "openSkill", skillId: "skill-1", kind: "review" })))).toBe(false);
    expect(isReviewed(active(reduce(reviewed(), { type: "acted", skill: draft, action: "release", focusHere: false })))).toBe(false);
  });
});

describe("scope lock", () => {
  it("clears private content and drops results that arrive later", () => {
    const editing = active(run(ready(), { type: "openCreate" }, typed("Private text"), { type: "requestStarted", operation: "save" }, { type: "fileStarted" }));
    const locked = reduce(editing, { type: "locked", reason: "scope_changed" });
    expect(locked).toEqual({ status: "locked", reason: "scope_changed", focus: { target: "heading" } });
    const late: PersonalSkillsEvent[] = [
      loaded([released], "list"), { type: "fileLoaded", markdown: "late text" }, { type: "saved", skill: released, focusHere: true },
      { type: "requestFinished" }, { type: "openCreate" }, { type: "locked", reason: "session_expired" }
    ];
    for (const event of late) expect(reduce(locked, event)).toBe(locked);
  });
});

describe("views", () => {
  it("compares the editor with its baseline and asks before a dirty source switch", () => {
    let state = active(reduce(ready(), { type: "openEdit", skillId: "skill-1" }));
    expect(isDirty(state.view)).toBe(false);
    state = active(run(state, typed("Changed"), { type: "sourceSwitched", kind: "markdown" }));
    expect(state.view).toMatchObject({ kind: "edit", discard: "markdown", editor: { kind: "inline" } });
    state = active(reduce(state, { type: "discardDismissed" }));
    expect(state.view).toMatchObject({ discard: null });
    expect(isDirty(state.view)).toBe(true);
    state = active(run(state, { type: "sourceSwitched", kind: "markdown" }, { type: "discardConfirmed" }));
    expect(state.view).toMatchObject({ kind: "edit", editor: { kind: "markdown", markdown: "" }, discard: null });
    expect(isDirty(state.view)).toBe(false);
  });

  it("opens the review of a saved revision with no results from the editor", () => {
    const state = active(run(ready(), { type: "openEdit", skillId: "skill-1" }, typed("Other text."),
      { type: "requestStarted", operation: "save" }, { type: "requestFailed", operation: "save", message: "Unavailable.", reveal: true },
      { type: "requestStarted", operation: "save" }, { type: "saved", skill: newer, focusHere: false }, { type: "requestFinished" }));
    expect(state.view).toEqual({ kind: "review", skillId: "skill-1", notice: null, actionError: null, reviewedVersion: null, history: null, historyOpen: false, confirmDelete: false });
    expect(selectedSkill(state)).toBe(newer);
    expect(state.pending).toBeNull();
  });

  it("gives a failure to the view that owns it and drops it on navigation", () => {
    const failed = active(run(ready(), { type: "openSkill", skillId: "skill-1", kind: "details" },
      { type: "requestStarted", operation: "disable" }, { type: "requestFailed", operation: "disable", message: "Unavailable.", reveal: true }));
    expect(failed.view).toMatchObject({ actionError: { operation: "disable", title: "Could not turn off meeting-notes", detail: "Unavailable." } });
    expect(failed.focus).toEqual({ target: "reveal", block: "disable" });
    expect(active(run(failed, { type: "openList" }, { type: "openSkill", skillId: "skill-1", kind: "details" })).view).toMatchObject({ actionError: null });
  });

  it("drops a history result for another skill and a file result outside an editor", () => {
    const details = active(run(ready([released, other]), { type: "openSkill", skillId: "skill-2", kind: "details" }));
    expect(reduce(details, { type: "historyLoaded", skillId: "skill-1", revisions: [revision], reveal: true })).toBe(details);
    expect(active(reduce(details, { type: "fileLoaded", markdown: "late text" })).view).toBe(details.view);
  });

  it("starts in the submissions view for a requested submission and keeps focus on the initial read", () => {
    const state = active(reduce(initialState(true), loaded([released], "initial", true)));
    expect(state.view).toEqual({ kind: "submissions", sourceSkillId: null });
    expect(state.focus).toBeNull();
  });
});
