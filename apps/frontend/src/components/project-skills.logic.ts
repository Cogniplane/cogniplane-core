import type { PersonalSkill, ProjectSkill, ProjectSkillRevision } from "@cogniplane/shared-types";
import { emptySkillContent, type SkillEditorState } from "./skill-editor-parts";

// Visible state of the project skill editor. Request admission, generations and
// focus stay in the controller hook (`use-project-skill-editor.ts`). For
// example, a second click in the same React batch runs before React applies a
// reducer update, so only a ref can reject it.

export type ProjectSkillOperation = "save" | "release" | "disable" | "delete" | "copy-list" | "copy-read" | "copy"
  | "source-read" | "source-update" | "history" | "load";

/** The editor text and the text it started from. The editor is dirty when they differ. */
export type EditorDraft = { editor: SkillEditorState; baseline: string };

/**
 * The screen. A selected skill ID can name a row that a reload removed;
 * `selectedSkill` then returns null.
 */
export type EditorView =
  | { kind: "list" }
  | { kind: "create"; draft: EditorDraft }
  | { kind: "edit"; skillId: string; draft: EditorDraft }
  | { kind: "details"; skillId: string; sourceCandidate: PersonalSkill | null; confirmDelete: boolean }
  | { kind: "copy"; candidate: PersonalSkill | null };

export type ReviewKind = "release" | "copy" | "source-update";

/**
 * The one revision the person confirmed they reviewed. A new review replaces
 * the previous one, so only one action can be approved at a time.
 */
export type ReviewIdentity =
  | { kind: "release"; skillId: string; revision: number; version: number }
  | { kind: "copy"; personalSkillId: string; revision: number }
  | { kind: "source-update"; skillId: string; sourceRevision: number; version: number };

/**
 * After a conflict or a 404, the editor waits for a current list before it
 * decides what happened to the skill. `editing` is false after Cancel. When
 * the skill still exists and the text was kept, the person must choose a version.
 */
export type Recovery =
  | { kind: "none" }
  | { kind: "awaiting-list"; skillId: string; editing: false }
  | { kind: "awaiting-list"; skillId: string; editing: true; savedDraft?: EditorDraft }
  | { kind: "awaiting-version-choice"; skillId: string };

export type ProjectSkillEditorState = {
  view: EditorView;
  review: ReviewIdentity | null;
  recovery: Recovery;
  /** A lock is final for this editor. The person must reload the page. */
  lock: { locked: false } | { locked: true; expired: boolean };
  list: { skills: ProjectSkill[]; canEdit: boolean; loading: boolean; readFailed: boolean };
  /** Released private skills that can be copied. */
  personal: PersonalSkill[];
  history: { skillId: string; revisions: ProjectSkillRevision[] } | null;
  request: { pending: ProjectSkillOperation | null; readingFile: boolean };
  /** `errorAt` selects the control that shows `error`. */
  feedback: { error: string | null; errorAt: ProjectSkillOperation; notice: string | null; fileError: string | null };
};

export type ProjectSkillEditorEvent =
  | { type: "createOpened" }
  | { type: "editOpened"; skillId: string }
  | { type: "detailsOpened"; skillId: string }
  | { type: "draftChanged"; editor: SkillEditorState }
  | { type: "sourceSwitched"; kind: SkillEditorState["kind"] }
  | { type: "cancelled" }
  | { type: "listOpened" }
  | { type: "localTextKept" }
  | { type: "latestVersionChosen" }
  | { type: "copyListLoaded"; skills: PersonalSkill[] }
  | { type: "copyCandidateRequested" }
  | { type: "copyCandidateLoaded"; skill: PersonalSkill }
  | { type: "sourceRequested" }
  | { type: "sourceLoaded"; skill: PersonalSkill }
  | { type: "reviewChanged"; kind: ReviewKind; checked: boolean }
  | { type: "deleteConfirmationChanged"; open: boolean }
  | { type: "skillSaved"; skill: ProjectSkill }
  | { type: "skillCopied"; skill: ProjectSkill }
  | { type: "sourceUpdated"; skill: ProjectSkill; sourceRevision: number }
  | { type: "skillActionSucceeded"; action: "release" | "disable"; skill: ProjectSkill; projectName: string }
  | { type: "skillDeleted"; skillId: string }
  | { type: "recoveryRequired" }
  | { type: "recoveryFinishedWithoutTarget"; message: string }
  | { type: "operationStarted"; operation: ProjectSkillOperation }
  | { type: "operationFailed"; message: string }
  | { type: "operationFinished"; operation: ProjectSkillOperation }
  | { type: "accessRefused" }
  | { type: "listReadStarted" }
  // "effect" is the mount read. "reload" is an explicit or access-triggered read.
  | { type: "listReadAccepted"; origin: "effect" | "reload"; skills: ProjectSkill[]; canEdit: boolean }
  | { type: "listReadFailed" }
  | { type: "listReadFinished" }
  | { type: "reloadRequested" }
  | { type: "historyLoaded"; skillId: string; revisions: ProjectSkillRevision[] }
  | { type: "historyClosed" }
  | { type: "fileReadStarted" }
  | { type: "fileReadSucceeded"; markdown: string }
  | { type: "fileReadFailed"; message: string }
  | { type: "fileReadFinished" }
  | { type: "accessChanged" }
  | { type: "scopeLocked"; expired: boolean };

const noRecovery: Recovery = { kind: "none" };

export function initialProjectSkillEditorState(): ProjectSkillEditorState {
  return {
    view: { kind: "list" },
    review: null,
    recovery: noRecovery,
    lock: { locked: false },
    list: { skills: [], canEdit: false, loading: true, readFailed: false },
    personal: [],
    history: null,
    request: { pending: null, readingFile: false },
    feedback: { error: null, errorAt: "load", notice: null, fileError: null }
  };
}

export function selectedSkillId(view: EditorView): string | null {
  return view.kind === "edit" || view.kind === "details" ? view.skillId : null;
}

export function selectedSkill(state: ProjectSkillEditorState): ProjectSkill | null {
  const id = selectedSkillId(state.view);
  return state.list.skills.find(skill => skill.id === id) ?? null;
}

export function editorDraft(view: EditorView): EditorDraft | null {
  return view.kind === "create" || view.kind === "edit" ? view.draft : null;
}

export function isDirty(view: EditorView): boolean {
  const draft = editorDraft(view);
  return draft !== null && JSON.stringify(draft.editor) !== draft.baseline;
}

/** The latest saved skill that the person must compare with their text, if any. */
export function conflictSkill(state: ProjectSkillEditorState): ProjectSkill | null {
  const selected = selectedSkill(state);
  return state.view.kind === "edit" && selected && state.recovery.kind === "awaiting-version-choice"
    && state.recovery.skillId === selected.id ? selected : null;
}

/**
 * A failed list read blocks editing. So does a recovery that still waits for a
 * list. A pending version choice does not, so Use the latest version can open
 * the refreshed skill.
 */
export function canOpenEdit(state: ProjectSkillEditorState): boolean {
  return !state.list.readFailed && state.recovery.kind !== "awaiting-list";
}

/** The identity that a review of `kind` approves on the current screen, or null. */
export function reviewIdentity(state: ProjectSkillEditorState, kind: ReviewKind): ReviewIdentity | null {
  const { view } = state;
  if (kind === "copy") {
    const candidate = view.kind === "copy" ? view.candidate : null;
    return candidate?.active ? { kind, personalSkillId: candidate.id, revision: candidate.active.revision } : null;
  }
  const selected = view.kind === "details" ? selectedSkill(state) : null;
  if (!selected) return null;
  if (kind === "release") return { kind, skillId: selected.id, revision: selected.latest.revision, version: selected.version };
  const source = view.kind === "details" ? view.sourceCandidate : null;
  return source?.active ? { kind, skillId: selected.id, sourceRevision: source.active.revision, version: selected.version } : null;
}

function sameReview(stored: ReviewIdentity | null, expected: ReviewIdentity): boolean {
  if (!stored) return false;
  switch (expected.kind) {
    case "release":
      return stored.kind === "release" && stored.skillId === expected.skillId
        && stored.revision === expected.revision && stored.version === expected.version;
    case "copy":
      return stored.kind === "copy" && stored.personalSkillId === expected.personalSkillId && stored.revision === expected.revision;
    case "source-update":
      return stored.kind === "source-update" && stored.skillId === expected.skillId
        && stored.sourceRevision === expected.sourceRevision && stored.version === expected.version;
  }
}

/** True only when the stored review matches the current revision and version for `kind`. */
export function isReviewed(state: ProjectSkillEditorState, kind: ReviewKind): boolean {
  const expected = reviewIdentity(state, kind);
  return expected !== null && sameReview(state.review, expected);
}

const emptyEditor = (kind: SkillEditorState["kind"]): SkillEditorState =>
  kind === "inline" ? { kind, content: { ...emptySkillContent } } : { kind, markdown: "" };
const startDraft = (editor: SkillEditorState): EditorDraft => ({ editor, baseline: JSON.stringify(editor) });
const released = (skill: PersonalSkill) => skill.enabled && skill.active;
const byName = (a: ProjectSkill, b: ProjectSkill) => a.latest.content.name.localeCompare(b.latest.content.name);

function withFeedback(state: ProjectSkillEditorState, feedback: Partial<ProjectSkillEditorState["feedback"]>): ProjectSkillEditorState {
  return { ...state, feedback: { ...state.feedback, ...feedback } };
}

function withDraft(state: ProjectSkillEditorState, editor: SkillEditorState, baseline?: string): ProjectSkillEditorState {
  const { view } = state;
  if (view.kind !== "create" && view.kind !== "edit") return state;
  return { ...state, view: { ...view, draft: { editor, baseline: baseline ?? view.draft.baseline } } };
}

// A returned skill replaces its row. Older history and reviews no longer apply,
// even when the ID is unchanged.
function replaceSkill(state: ProjectSkillEditorState, skill: ProjectSkill): ProjectSkillEditorState {
  const skills = [...state.list.skills.filter(item => item.id !== skill.id), skill].sort(byName);
  return { ...state, list: { ...state.list, skills }, history: null, review: null };
}

function details(skillId: string): EditorView {
  return { kind: "details", skillId, sourceCandidate: null, confirmDelete: false };
}

function openEdit(state: ProjectSkillEditorState, skillId: string): ProjectSkillEditorState {
  const skill = state.list.skills.find(item => item.id === skillId);
  if (!skill || !canOpenEdit(state)) return state;
  return withFeedback({
    ...state,
    view: { kind: "edit", skillId, draft: startDraft({ kind: "inline", content: { ...skill.latest.content } }) },
    review: null, history: null, recovery: noRecovery
  }, { error: null, notice: null, fileError: null });
}

// A reload decides what an awaiting-list recovery found. It reads the recorded
// target, not the current screen: a missing target that is no longer edited
// returns to the list even when another skill is open.
function reconcileRecovery(state: ProjectSkillEditorState): ProjectSkillEditorState {
  const target = state.recovery;
  if (target.kind !== "awaiting-list") return state;
  if (state.list.skills.some(skill => skill.id === target.skillId)) {
    return withFeedback({
      ...state,
      recovery: target.editing ? { kind: "awaiting-version-choice", skillId: target.skillId } : noRecovery
    }, { error: `Project skills were reloaded. Review the current revision before trying again.${target.editing ? " Your unsaved text is still here." : ""}` });
  }
  const draft = target.editing ? editorDraft(state.view) ?? target.savedDraft : null;
  return withFeedback({
    ...state,
    view: draft ? { kind: "create", draft } : { kind: "list" },
    recovery: noRecovery, history: null, review: null
  }, {
    notice: draft
      ? "This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel."
      : "This skill was deleted elsewhere. It is no longer in this project.",
    error: null
  });
}

/**
 * Applies one editor event. An event that does not fit the current state, such
 * as a result for a screen the person already left, returns the same state.
 */
export function projectSkillEditorReducer(state: ProjectSkillEditorState, event: ProjectSkillEditorEvent): ProjectSkillEditorState {
  if (state.lock.locked) return state;
  const { view } = state;
  switch (event.type) {
    case "createOpened":
      if (view.kind !== "list") return state;
      return withFeedback({ ...state, view: { kind: "create", draft: startDraft(emptyEditor("inline")) }, review: null, history: null },
        { error: null, notice: null, fileError: null });
    case "editOpened":
      return view.kind === "details" && view.skillId === event.skillId ? openEdit(state, event.skillId) : state;
    case "latestVersionChosen":
      return view.kind === "edit" && state.recovery.kind === "awaiting-version-choice" && state.recovery.skillId === view.skillId
        ? openEdit(state, view.skillId) : state;
    case "detailsOpened":
      if (view.kind !== "list") return state;
      return withFeedback({ ...state, view: details(event.skillId), review: null, history: null }, { error: null, notice: null });
    case "draftChanged":
      return withDraft(state, event.editor);
    case "sourceSwitched": {
      const draft = editorDraft(view);
      if (!draft || draft.editor.kind === event.kind) return state;
      const editor = emptyEditor(event.kind);
      return withFeedback(withDraft(state, editor, JSON.stringify(editor)), { fileError: null });
    }
    case "cancelled": {
      if (view.kind !== "create" && view.kind !== "edit") return state;
      const recovery: Recovery = state.recovery.kind === "awaiting-list"
        ? { kind: "awaiting-list", skillId: state.recovery.skillId, editing: false } : noRecovery;
      return withFeedback({ ...state, view: view.kind === "edit" ? details(view.skillId) : { kind: "list" }, recovery }, { error: null });
    }
    case "listOpened":
      if (view.kind !== "details" && view.kind !== "copy") return state;
      return withFeedback({ ...state, view: { kind: "list" }, review: null, history: null }, { error: null, notice: null });
    case "localTextKept":
      if (state.recovery.kind !== "awaiting-version-choice") return state;
      return withFeedback({ ...state, recovery: noRecovery }, { error: null });
    case "copyListLoaded":
      if (view.kind !== "list") return state;
      return withFeedback({ ...state, view: { kind: "copy", candidate: null }, personal: event.skills.filter(released) }, { error: null });
    case "copyCandidateRequested":
      return view.kind === "copy" ? { ...state, view: { ...view, candidate: null }, review: null } : state;
    case "copyCandidateLoaded":
      if (view.kind !== "copy") return state;
      if (!released(event.skill)) return withFeedback(state, { error: "This private skill is no longer released. Reload the private library." });
      return { ...state, view: { ...view, candidate: event.skill }, review: null };
    case "sourceRequested":
      return view.kind === "details" ? { ...state, view: { ...view, sourceCandidate: null }, review: null } : state;
    case "sourceLoaded":
      if (view.kind !== "details") return state;
      if (!released(event.skill)) return withFeedback(state, { error: "Your private source is no longer released." });
      return { ...state, view: { ...view, sourceCandidate: event.skill }, review: null };
    case "reviewChanged": {
      if (!event.checked) return state.review ? { ...state, review: null } : state;
      const review = reviewIdentity(state, event.kind);
      return review ? { ...state, review } : state;
    }
    case "deleteConfirmationChanged":
      return view.kind === "details" ? { ...state, view: { ...view, confirmDelete: event.open } } : state;
    case "skillSaved": {
      if (view.kind !== "create" && view.kind !== "edit") return state;
      // An effect read can leave recovery unresolved through a save. Keep the
      // saved text and baseline until a reload decides whether the target exists.
      const recovery: Recovery = state.recovery.kind === "awaiting-list" && state.recovery.editing
        ? { ...state.recovery, savedDraft: startDraft(view.draft.editor) } : state.recovery;
      return withFeedback({ ...replaceSkill(state, event.skill), view: details(event.skill.id), recovery },
        { notice: `Draft revision ${event.skill.latest.revision} saved. Release is a separate action.` });
    }
    case "skillCopied":
      if (view.kind !== "copy") return state;
      return withFeedback({ ...replaceSkill(state, event.skill), view: details(event.skill.id) },
        { notice: "Private revision copied into a separate project draft. Review it before release." });
    case "sourceUpdated":
      if (view.kind !== "details" || view.skillId !== event.skill.id) return state;
      return withFeedback({ ...replaceSkill(state, event.skill), view: { ...view, sourceCandidate: null } },
        { notice: `Private revision ${event.sourceRevision} copied into draft revision ${event.skill.latest.revision}. Release is a separate action.` });
    case "skillActionSucceeded":
      if (view.kind !== "details" || view.skillId !== event.skill.id) return state;
      return withFeedback({ ...replaceSkill(state, event.skill), view: { ...view, sourceCandidate: null, confirmDelete: false } }, {
        notice: event.action === "release"
          ? `Revision ${event.skill.active?.revision} released in ${event.projectName}. It applies on the next turn when selected.`
          : "This project skill is off for future turns."
      });
    case "skillDeleted":
      if (view.kind !== "details" || view.skillId !== event.skillId) return state;
      return { ...state, view: { kind: "list" }, list: { ...state.list, skills: state.list.skills.filter(item => item.id !== event.skillId) } };
    case "recoveryRequired": {
      // The read block starts now. Writes stay blocked until a list read succeeds.
      const skillId = selectedSkillId(view);
      const next: EditorView = view.kind === "details" ? { ...view, sourceCandidate: null, confirmDelete: false }
        : view.kind === "copy" ? { ...view, candidate: null } : view;
      return {
        ...state, view: next, review: null,
        recovery: skillId ? { kind: "awaiting-list", skillId, editing: view.kind === "edit" } : state.recovery,
        list: { ...state.list, readFailed: true }
      };
    }
    case "recoveryFinishedWithoutTarget":
      return withFeedback(state, { error: `${event.message} Review the source again before trying to copy.` });
    case "operationStarted":
      if (state.request.pending !== null) return state;
      return withFeedback({ ...state, request: { ...state.request, pending: event.operation } },
        { errorAt: event.operation, error: null, notice: null });
    case "operationFailed":
      return withFeedback(state, { error: event.message });
    case "operationFinished":
      return state.request.pending === event.operation ? { ...state, request: { ...state.request, pending: null } } : state;
    case "accessRefused":
      return { ...state, list: { ...state.list, canEdit: false } };
    case "listReadStarted":
      return { ...state, list: { ...state.list, loading: true } };
    case "listReadAccepted": {
      const accepted = { ...state, list: { ...state.list, skills: event.skills, canEdit: event.canEdit, readFailed: false } };
      if (event.origin === "effect") return accepted;
      return reconcileRecovery(withFeedback({
        ...accepted, history: null, review: null,
        view: view.kind === "details" ? { ...view, sourceCandidate: null } : view
      }, { error: null }));
    }
    case "listReadFailed":
      return { ...state, list: { ...state.list, readFailed: true } };
    case "listReadFinished":
      return { ...state, list: { ...state.list, loading: false } };
    case "reloadRequested":
      return state.recovery.kind === "awaiting-list" ? state : withFeedback(state, { errorAt: "load" });
    case "historyLoaded":
      return view.kind === "details" && view.skillId === event.skillId
        ? { ...state, history: { skillId: event.skillId, revisions: event.revisions } } : state;
    case "historyClosed":
      return withFeedback({ ...state, history: null }, { error: null });
    case "fileReadStarted":
      return withFeedback({ ...state, request: { ...state.request, readingFile: true } }, { fileError: null });
    case "fileReadSucceeded":
      return withDraft(state, { kind: "markdown", markdown: event.markdown });
    case "fileReadFailed":
      return withFeedback(state, { fileError: event.message });
    case "fileReadFinished":
      return { ...state, request: { ...state.request, readingFile: false } };
    case "accessChanged":
      return { ...state, request: { pending: null, readingFile: false }, review: null };
    case "scopeLocked": {
      // Drop every draft, list, candidate and recovery target in one step.
      const initial = initialProjectSkillEditorState();
      return { ...initial, lock: { locked: true, expired: event.expired }, list: { ...initial.list, loading: false } };
    }
    default:
      return ignoreUnknownEvent(event, state);
  }
}

// The `never` parameter makes TypeScript report an event type without a case.
function ignoreUnknownEvent(_event: never, state: ProjectSkillEditorState): ProjectSkillEditorState {
  return state;
}
