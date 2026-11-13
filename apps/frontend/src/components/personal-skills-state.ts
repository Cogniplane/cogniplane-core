import type { PersonalSkill, PersonalSkillRevision } from "@cogniplane/shared-types";
import { emptySkillContent, type SkillEditorState as Editor } from "./skill-editor-parts";

// State and transitions of the private skill editor. The reducer is pure. The
// controller (use-personal-skills.ts) sends requests and reads the DOM, then
// reports each result here as an event.

export type Operation = "save" | "release" | "disable" | "delete" | "history" | "latest";
/** An operation whose result shows in the block of its trigger. */
export type Block = Exclude<Operation, "latest">;
/** A failed write or read, shown at the control that started it. */
export type ActionError = { operation: Operation; tone: "danger" | "attention"; title: string; detail: string };
/** A result for the whole view: a confirmed write, or a skill changed or deleted elsewhere. */
export type Notice = { tone: "success" | "attention"; title: string; detail?: string };
/** The change that waits for the member to discard unsaved text. */
export type Discard = "cancel" | Editor["kind"];
export type LockReason = "scope_changed" | "session_expired";
/**
 * Where focus goes after a transition. The component applies each request once.
 * It moves focus to a heading only when the heading exists, and it scrolls a
 * revealed block into view without moving focus.
 */
export type FocusRequest = { target: "heading" | "recovery" | "conflict" } | { target: "reveal"; block: Block };

type EditorFields = {
  editor: Editor;
  /** The editor as JSON when it opened or its source changed. Text that differs is unsaved. */
  baseline: string;
  notice: Notice | null;
  actionError: ActionError | null;
  fileError: string | null;
  discard: Discard | null;
};
type SkillFields = {
  skillId: string;
  notice: Notice | null;
  actionError: ActionError | null;
  /** The skill version the member marked as reviewed. Release needs the current version. */
  reviewedVersion: number | null;
  history: PersonalSkillRevision[] | null;
  historyOpen: boolean;
  confirmDelete: boolean;
};
export type CreateView = { kind: "create" } & EditorFields;
/** `version` is the skill version the text is based on. Save sends it. */
export type EditView = { kind: "edit"; skillId: string; version: number } & EditorFields;
export type SkillView = { kind: "details" | "review" } & SkillFields;
export type View =
  | { kind: "list"; notice: Notice | null }
  | CreateView
  | EditView
  | SkillView
  | { kind: "submissions"; sourceSkillId: string | null };

/**
 * A write failed because its skill changed or is gone, and no full list read
 * has succeeded since. All writes stay blocked until one does. Navigation does
 * not clear it. The block is global because a second conflict could replace a
 * per-skill target.
 */
export type Recovery = { skillId: string; reason: string };

export type ActiveState = {
  status: "active";
  /** The last confirmed list. It outlives views. */
  skills: PersonalSkill[];
  list: { loading: boolean; error: string | null };
  /** The request in progress. Its label stays while an automatic reread runs. */
  pending: Operation | null;
  readingFile: boolean;
  recovery: Recovery | null;
  view: View;
  focus: FocusRequest | null;
};
/** The account or organization changed, or the session expired. No private content stays. */
export type LockedState = { status: "locked"; reason: LockReason; focus: FocusRequest | null };
export type PersonalSkillsState = ActiveState | LockedState;

/** `initial` loads the page, `list` is Reload skills, `recovery` follows a write conflict. */
export type ListRead = "initial" | "list" | "recovery";

export type PersonalSkillsEvent =
  // Navigation
  | { type: "openList" }
  | { type: "openCreate" }
  | { type: "openEdit"; skillId: string }
  | { type: "openSkill"; skillId: string; kind: SkillView["kind"] }
  | { type: "openSubmissions"; sourceSkillId: string | null }
  | { type: "cancelEditor" }
  // Editor
  | { type: "editorChanged"; editor: Editor }
  | { type: "sourceSwitched"; kind: Editor["kind"] }
  | { type: "discardDismissed" }
  | { type: "discardConfirmed" }
  | { type: "keepMyText" }
  | { type: "useLatest" }
  | { type: "fileStarted" }
  | { type: "fileLoaded"; markdown: string }
  | { type: "fileFailed"; error: string }
  // Skill details and review
  | { type: "reviewMarked"; reviewed: boolean }
  | { type: "deleteConfirmation"; open: boolean }
  | { type: "historyToggled" }
  // List reads. `focusHere` is true when the member did not move focus away.
  | { type: "listStarted" }
  | { type: "listLoaded"; skills: PersonalSkill[]; read: ListRead; focusHere: boolean }
  | { type: "listFailed"; error: string }
  // Requests and their results
  | { type: "requestStarted"; operation: Operation }
  | { type: "requestFinished" }
  | { type: "requestFailed"; operation: Operation; message: string; reveal: boolean }
  | { type: "writeConflicted"; skillId: string; reason: string; focusHere: boolean }
  | { type: "saved"; skill: PersonalSkill; focusHere: boolean }
  | { type: "acted"; skill: PersonalSkill; action: "release" | "disable"; focusHere: boolean }
  | { type: "deleted"; skillId: string; focusHere: boolean }
  | { type: "historyLoaded"; skillId: string; revisions: PersonalSkillRevision[]; reveal: boolean }
  | { type: "locked"; reason: LockReason };

export function initialState(submissions: boolean): ActiveState {
  return {
    status: "active", skills: [], list: { loading: true, error: null }, pending: null, readingFile: false, recovery: null,
    view: submissions ? { kind: "submissions", sourceSkillId: null } : { kind: "list", notice: null }, focus: null
  };
}

// Selectors

const find = (skills: PersonalSkill[], id: string) => skills.find((skill) => skill.id === id) ?? null;

/** The skill that the view edits, shows or reviews. */
export function selectedSkill(state: ActiveState): PersonalSkill | null {
  const { view } = state;
  return view.kind === "edit" || view.kind === "details" || view.kind === "review" ? find(state.skills, view.skillId) : null;
}

export function isDirty(view: View): boolean {
  return (view.kind === "create" || view.kind === "edit") && JSON.stringify(view.editor) !== view.baseline;
}

/** The saved skill is newer than the text in the editor. Save waits for Keep my text or Use the latest version. */
export function hasConflict(state: ActiveState): boolean {
  const skill = selectedSkill(state);
  return state.view.kind === "edit" && skill !== null && skill.version !== state.view.version;
}

export function isReviewed(state: ActiveState): boolean {
  const skill = selectedSkill(state);
  return (state.view.kind === "details" || state.view.kind === "review") && skill !== null && state.view.reviewedVersion === skill.version;
}

// Views

const focus = (target: "heading" | "recovery" | "conflict"): FocusRequest => ({ target });
const blankEditor = (kind: Editor["kind"] = "inline"): Editor =>
  kind === "inline" ? { kind, content: { ...emptySkillContent } } : { kind, markdown: "" };
const editorFields = (editor: Editor): EditorFields =>
  ({ editor, baseline: JSON.stringify(editor), notice: null, actionError: null, fileError: null, discard: null });
const skillView = (kind: SkillView["kind"], skillId: string, notice: Notice | null = null): SkillView =>
  ({ kind, skillId, notice, actionError: null, reviewedVersion: null, history: null, historyOpen: false, confirmDelete: false });
const editView = (skill: PersonalSkill): EditView =>
  ({ kind: "edit", skillId: skill.id, version: skill.version, ...editorFields({ kind: "inline", content: { ...skill.latest.content } }) });
/** A new view drops the results of the previous one, so a message never describes another skill. */
const navigate = (state: ActiveState, view: View): ActiveState => ({ ...state, view, focus: focus("heading") });

function leaveEditor(state: ActiveState): ActiveState {
  const { view } = state;
  return navigate(state, view.kind === "edit" && find(state.skills, view.skillId) ? skillView("details", view.skillId) : { kind: "list", notice: null });
}

function withEditor(state: ActiveState, change: (view: CreateView | EditView) => CreateView | EditView): ActiveState {
  const { view } = state;
  return view.kind === "create" || view.kind === "edit" ? { ...state, view: change(view) } : state;
}

function withSkillView(state: ActiveState, change: (view: SkillView, skill: PersonalSkill) => SkillView): ActiveState {
  const { view } = state;
  const skill = selectedSkill(state);
  if ((view.kind !== "details" && view.kind !== "review") || !skill) return state;
  return { ...state, view: change(view, skill) };
}

function changeSource<V extends CreateView | EditView>(view: V, kind: Editor["kind"]): V {
  return { ...view, ...editorFields(blankEditor(kind)), notice: view.notice };
}

// Results

const sortByName = (skills: PersonalSkill[]) => skills.sort((a, b) => a.latest.content.name.localeCompare(b.latest.content.name));
const upsert = (skills: PersonalSkill[], skill: PersonalSkill) => sortByName([...skills.filter((item) => item.id !== skill.id), skill]);

const deletedElsewhere = (editing: boolean): Notice => ({
  tone: "attention", title: "This skill was deleted elsewhere",
  detail: editing ? "Your text is still here. Save it as a new draft if you want to keep it." : "It is no longer in your list."
});

function failureTitle(operation: Operation, skill: PersonalSkill | null): string {
  switch (operation) {
    case "save": return "Draft not saved";
    case "release": return skill ? `Could not make revision ${skill.latest.revision} available` : "Could not make the revision available";
    case "disable": return `Could not turn off ${skill?.latest.content.name ?? "this skill"}`;
    case "delete": return `Could not delete ${skill?.latest.content.name ?? "this skill"}`;
    case "history": return "Could not load revision history";
    case "latest": return "Could not reload the latest version";
  }
}

/**
 * Applies a successful full list read to the open view. It clears the recovery,
 * because the list now confirms every skill. The view decides what follows:
 * - an open editor whose skill is gone becomes a new draft with the same text;
 * - an open editor whose skill is newer shows the Keep my text choice (hasConflict);
 * - details or review of a skill that is gone return to the list with a notice;
 * - details or review of the recovered skill show that it changed elsewhere.
 * A draft that the member discarded is not in the view, so it does not come back.
 */
function reconcile(state: ActiveState, skills: PersonalSkill[], read: ListRead, focusHere: boolean): ActiveState {
  const { recovery, view } = state;
  const next: ActiveState = { ...state, skills, list: { loading: false, error: null }, recovery: null };
  // A read that removes the recovery notice or the reload button moves focus only if the member left it there.
  const settle = (target: "heading" | "conflict") => read !== "initial" && focusHere ? focus(target) : state.focus;
  switch (view.kind) {
    case "edit": {
      const skill = find(skills, view.skillId);
      if (!skill) return { ...next, focus: focus("heading"), view: {
        kind: "create", editor: view.editor, baseline: JSON.stringify(blankEditor()), notice: deletedElsewhere(true),
        actionError: null, fileError: view.fileError, discard: null
      } };
      if (!recovery) return next;
      return { ...next, view: { ...view, actionError: null }, focus: settle(skill.version !== view.version ? "conflict" : "heading") };
    }
    case "details":
    case "review": {
      if (!find(skills, view.skillId)) return { ...next, view: { kind: "list", notice: deletedElsewhere(false) }, focus: focus("heading") };
      const cleared: SkillView = { ...view, history: null, historyOpen: false };
      if (!recovery) return { ...next, view: cleared };
      const notice: Notice | null = recovery.skillId === view.skillId
        ? { tone: "attention", title: "This skill changed elsewhere", detail: `${recovery.reason} Review the current version before you try again.` }
        : view.notice;
      return { ...next, view: { ...cleared, notice }, focus: settle("heading") };
    }
    case "list":
      return { ...next, view: read === "list" ? { kind: "list", notice: null } : view, focus: settle("heading") };
    case "create":
      return recovery ? { ...next, focus: settle("heading") } : next;
    case "submissions":
      return next;
  }
}

export function personalSkillsReducer(state: PersonalSkillsState, event: PersonalSkillsEvent): PersonalSkillsState {
  // A lock is final. The reducer drops results that arrive after it.
  if (state.status === "locked") return state;
  if (event.type === "locked") return { status: "locked", reason: event.reason, focus: focus("heading") };
  return reduceActive(state, event);
}

function reduceActive(state: ActiveState, event: Exclude<PersonalSkillsEvent, { type: "locked" }>): ActiveState {
  switch (event.type) {
    case "openList":
      return navigate(state, { kind: "list", notice: null });
    case "openCreate":
      // Writes stay blocked during a recovery, so a new draft could not be saved.
      return state.recovery ? state : navigate(state, { kind: "create", ...editorFields(blankEditor()) });
    case "openEdit": {
      // A stale skill must not open for editing before a list read confirms it.
      const skill = find(state.skills, event.skillId);
      return skill && !state.recovery ? navigate(state, editView(skill)) : state;
    }
    case "openSkill":
      return find(state.skills, event.skillId) ? navigate(state, skillView(event.kind, event.skillId)) : state;
    case "openSubmissions":
      // The submissions view moves focus to its own heading.
      return { ...state, view: { kind: "submissions", sourceSkillId: event.sourceSkillId } };
    case "cancelEditor":
      if (state.view.kind !== "create" && state.view.kind !== "edit") return state;
      return isDirty(state.view) ? withEditor(state, (view) => ({ ...view, discard: "cancel" })) : leaveEditor(state);

    case "editorChanged":
      return withEditor(state, (view) => ({ ...view, editor: event.editor }));
    case "sourceSwitched":
      return withEditor(state, (view) => {
        if (view.editor.kind === event.kind) return view;
        if (isDirty(view)) return { ...view, discard: event.kind };
        return changeSource(view, event.kind);
      });
    case "discardDismissed":
      return withEditor(state, (view) => ({ ...view, discard: null }));
    case "discardConfirmed": {
      const { view } = state;
      if ((view.kind !== "create" && view.kind !== "edit") || !view.discard) return state;
      return view.discard === "cancel" ? leaveEditor(state) : { ...state, view: changeSource(view, view.discard) };
    }
    case "keepMyText": {
      const skill = selectedSkill(state);
      if (state.view.kind !== "edit" || !skill) return state;
      // Keep local text, but compare later edits with the accepted server version.
      return {
        ...state, view: { ...state.view, version: skill.version, baseline: editView(skill).baseline, actionError: null },
        focus: focus("heading")
      };
    }
    case "useLatest": {
      const skill = selectedSkill(state);
      return state.view.kind === "edit" && skill && !state.recovery ? navigate(state, editView(skill)) : state;
    }
    case "fileStarted":
      return withEditor({ ...state, readingFile: true }, (view) => ({ ...view, fileError: null }));
    case "fileLoaded":
      return withEditor({ ...state, readingFile: false }, (view) => ({ ...view, editor: { kind: "markdown", markdown: event.markdown } }));
    case "fileFailed":
      return withEditor({ ...state, readingFile: false }, (view) => ({ ...view, fileError: event.error }));

    case "reviewMarked":
      return withSkillView(state, (view, skill) => ({ ...view, reviewedVersion: event.reviewed ? skill.version : null }));
    case "deleteConfirmation":
      return withSkillView(state, (view) => ({ ...view, confirmDelete: event.open, actionError: event.open ? view.actionError : null }));
    case "historyToggled": {
      const { view } = state;
      if ((view.kind !== "details" && view.kind !== "review") || (!view.historyOpen && !view.history)) return state;
      return view.historyOpen ? { ...state, view: { ...view, historyOpen: false } }
        : { ...state, view: { ...view, historyOpen: true }, focus: { target: "reveal", block: "history" } };
    }

    case "listStarted":
      return { ...state, list: { ...state.list, loading: true } };
    case "listFailed":
      return { ...state, list: { loading: false, error: event.error } };
    case "listLoaded":
      return reconcile(state, event.skills, event.read, event.focusHere);

    case "requestStarted": {
      const { view } = state;
      const next = { ...state, pending: event.operation };
      // A history read keeps the notice. Other requests replace it with their own result.
      const notice = event.operation === "history" && view.kind !== "submissions" ? view.notice : null;
      if (view.kind === "submissions") return next;
      if (view.kind === "list") return { ...next, view: { ...view, notice } };
      return { ...next, view: { ...view, actionError: null, notice } };
    }
    case "requestFinished":
      return { ...state, pending: null };
    case "requestFailed": {
      const { view } = state;
      if (view.kind === "list" || view.kind === "submissions") return state;
      const detail = event.operation === "save" ? `${event.message} Your text is still here.` : event.message;
      const actionError: ActionError = { operation: event.operation, tone: "danger", title: failureTitle(event.operation, selectedSkill(state)), detail };
      const reveal = event.reveal && event.operation !== "latest" ? { target: "reveal" as const, block: event.operation } : state.focus;
      return { ...state, view: { ...view, actionError }, focus: reveal };
    }
    case "writeConflicted": {
      const { view } = state;
      return {
        ...state, recovery: { skillId: event.skillId, reason: event.reason },
        view: view.kind === "details" || view.kind === "review" ? { ...view, reviewedVersion: null } : view,
        focus: event.focusHere ? focus("recovery") : state.focus
      };
    }
    case "saved":
      return { ...state, skills: upsert(state.skills, event.skill), view: skillView("review", event.skill.id), focus: event.focusHere ? focus("heading") : state.focus };
    case "acted": {
      const { skill } = event;
      const { name } = skill.latest.content;
      const notice: Notice = event.action === "release"
        ? { tone: "success", title: `Revision ${skill.active?.revision ?? skill.latest.revision} is in use`, detail: `${name} is available for your chats.` }
        : { tone: "success", title: `${name} is off`, detail: "It is not available for your chats. Its revisions stay saved." };
      return { ...state, skills: upsert(state.skills, skill), view: skillView("details", skill.id, notice), focus: event.focusHere ? focus("heading") : state.focus };
    }
    case "deleted": {
      const name = find(state.skills, event.skillId)?.latest.content.name ?? "this skill";
      return {
        ...state, skills: state.skills.filter((skill) => skill.id !== event.skillId),
        view: { kind: "list", notice: { tone: "success", title: `Deleted ${name} and its revision history` } },
        focus: event.focusHere ? focus("heading") : state.focus
      };
    }
    case "historyLoaded": {
      const { view } = state;
      if ((view.kind !== "details" && view.kind !== "review") || view.skillId !== event.skillId) return state;
      return { ...state, view: { ...view, history: event.revisions, historyOpen: true }, focus: event.reveal ? { target: "reveal", block: "history" } : state.focus };
    }
  }
}
