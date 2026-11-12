"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { ProjectSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { getPersonalSkill, getPersonalSkills } from "@/lib/personal-skills-api";
import {
  actOnProjectSkill, copyPersonalSkillToProject, createProjectSkill, deleteProjectSkill,
  getProjectSkillHistory, getProjectSkills, updateProjectSkill, updateProjectSkillFromPersonal
} from "@/lib/project-skills-api";
import {
  canOpenEdit, conflictSkill, editorDraft, initialProjectSkillEditorState, isDirty, isReviewed, projectSkillEditorReducer,
  selectedSkill, selectedSkillId, type ProjectSkillOperation, type ReviewKind
} from "@/components/project-skills.logic";
import { readSkillMarkdownFile, skillEditorComplete, skillEditorSource, type SkillEditorState } from "@/components/skill-editor-parts";

const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";

export type ProjectSkillEditorOptions = {
  scope: ProjectSkillScope; projectName: string; archived: boolean; canManage: boolean;
  onChanged?: () => void; onAccessFailure?: () => Promise<unknown>;
};

/**
 * Runs the project skill editor: API calls, error handling and focus. The
 * reducer in `project-skills.logic.ts` owns the visible state.
 *
 * Refs, not state, admit requests and file reads. A second click in the same
 * React batch sees the ref at once. Generation and read numbers discard
 * results that arrive after an unmount, a lock, an access change or a newer
 * list read. The caller keys the editor by scope.
 */
export function useProjectSkillEditor({ scope, projectName, archived, canManage, onChanged, onAccessFailure }: ProjectSkillEditorOptions) {
  const [state, dispatch] = useReducer(projectSkillEditorReducer, undefined, initialProjectSkillEditorState);
  const requestPending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const lockedRef = useRef(false);
  const fileRead = useRef(0);
  const filePending = useRef(false);
  const readNumber = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const previousAccess = useRef({ canManage, archived });

  const { view, list, request, feedback } = state;
  const mode = view.kind;
  const selectedId = selectedSkillId(view);
  const selected = selectedSkill(state);
  const locked = state.lock.locked;
  const { loading, readFailed } = list;
  const { pending, readingFile } = request;
  const busy = pending !== null;
  const editable = list.canEdit && canManage && !archived && !locked;
  const disabled = !editable || busy || loading || readingFile || readFailed;
  const actionDisabled = (operation: ProjectSkillOperation, extra = false) =>
    extra || !editable || loading || readingFile || readFailed || (busy && pending !== operation);
  const editor = editorDraft(view)?.editor ?? null;
  const dirty = isDirty(view);
  const conflict = conflictSkill(state);
  const copyCandidate = view.kind === "copy" ? view.candidate : null;
  const sourceCandidate = view.kind === "details" ? view.sourceCandidate : null;
  const reviewed = { release: isReviewed(state, "release"), copy: isReviewed(state, "copy"), sourceUpdate: isReviewed(state, "source-update") };

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; fileRead.current += 1; };
  }, []);
  // A request for focus waits for the next change of screen, selection or list.
  useLayoutEffect(() => { if (pendingFocus.current) { pendingFocus.current = false; heading.current?.focus(); } }, [mode, selectedId, list.skills]);
  const lock = useCallback((sessionExpired = false) => {
    pendingFocus.current = heading.current?.closest("section")?.contains(document.activeElement) ?? false;
    lockedRef.current = true; generation.current += 1; fileRead.current += 1;
    filePending.current = false; requestPending.current = false;
    dispatch({ type: "scopeLocked", expired: sessionExpired });
  }, []);
  const check = useCallback((actual: ProjectSkillScope) => {
    if (!mounted.current || lockedRef.current) return false;
    if (actual.tenantId === scope.tenantId && actual.userId === scope.userId && actual.projectId === scope.projectId) return true;
    lock(); return false;
  }, [scope.tenantId, scope.userId, scope.projectId, lock]);
  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.code === "project_skill_scope_changed")) {
      lock(cause.status === 401); return;
    }
    dispatch({ type: "operationFailed", message: message(cause) });
    if (cause instanceof ApiError && (cause.status === 403 || cause.code === "project_archived")) {
      dispatch({ type: "accessRefused" }); void onAccessFailure?.();
    }
  }, [lock, onAccessFailure]);
  const reload = useCallback(async () => {
    if (lockedRef.current) return;
    const number = ++readNumber.current, epoch = generation.current;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current && number === readNumber.current;
    dispatch({ type: "listReadStarted" });
    try {
      const result = await getProjectSkills(scope.projectId);
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "listReadAccepted", origin: "reload", skills: result.skills, canEdit: result.canEdit });
    } catch (cause) {
      if (current()) { dispatch({ type: "listReadFailed" }); fail(cause); }
    } finally { if (current()) dispatch({ type: "listReadFinished" }); }
  }, [scope.projectId, check, fail]);
  // The mount read shares the read number with reloads. It does not clear
  // history or reviews and does not reconcile recovery.
  useEffect(() => {
    let active = true;
    const epoch = generation.current, number = ++readNumber.current;
    const current = () => active && mounted.current && !lockedRef.current && epoch === generation.current && number === readNumber.current;
    getProjectSkills(scope.projectId).then(result => {
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "listReadAccepted", origin: "effect", skills: result.skills, canEdit: result.canEdit });
    }).catch((cause: unknown) => { if (current()) { dispatch({ type: "listReadFailed" }); fail(cause); } })
      .finally(() => { if (current()) dispatch({ type: "listReadFinished" }); });
    return () => { active = false; };
  }, [scope.projectId, check, fail]);
  // A permission or archive change makes held results stale. Release their
  // admission here: their finally blocks see the old generation and skip it.
  useLayoutEffect(() => {
    const previous = previousAccess.current;
    previousAccess.current = { canManage, archived };
    if ((previous.canManage !== canManage || previous.archived !== archived) && !lockedRef.current) {
      generation.current += 1; fileRead.current += 1; filePending.current = false; requestPending.current = false;
      dispatch({ type: "accessChanged" });
      void reload();
    }
  }, [canManage, archived, reload]);

  const samePersonalScope = (actual: { tenantId: string; userId: string }) =>
    actual.tenantId === scope.tenantId && actual.userId === scope.userId;
  const run = async (operation: ProjectSkillOperation, work: (current: () => boolean, trigger: Element | null) => Promise<void>, readOnly = false) => {
    if (requestPending.current || loading || lockedRef.current || filePending.current || (!readOnly && (!editable || readFailed))) return;
    requestPending.current = true;
    const epoch = generation.current, trigger = document.activeElement;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current;
    dispatch({ type: "operationStarted", operation });
    try { await work(current, trigger); }
    catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && (cause.code === "project_skill_conflict" || cause.status === 404)) {
        // The operation stays pending until the reload settles.
        dispatch({ type: "recoveryRequired" });
        await reload();
        if (current() && !selectedId) dispatch({ type: "recoveryFinishedWithoutTarget", message: message(cause) });
      } else fail(cause);
    } finally {
      if (current()) { requestPending.current = false; dispatch({ type: "operationFinished", operation }); }
    }
  };

  const beginCreate = () => { dispatch({ type: "createOpened" }); pendingFocus.current = true; };
  const openDetails = (skillId: string) => { dispatch({ type: "detailsOpened", skillId }); pendingFocus.current = true; };
  const beginEdit = () => {
    if (!selected || !canOpenEdit(state)) return;
    dispatch({ type: "editOpened", skillId: selected.id }); pendingFocus.current = true;
  };
  // The layout effect does not run again when the screen and list stay the
  // same, so this focus request waits for a later list change.
  const chooseLatestVersion = () => {
    if (!conflict || !canOpenEdit(state)) return;
    dispatch({ type: "latestVersionChosen" }); pendingFocus.current = true;
  };
  const keepLocalText = () => dispatch({ type: "localTextKept" });
  const changeDraft = (next: SkillEditorState) => dispatch({ type: "draftChanged", editor: next });
  const switchSource = (kind: SkillEditorState["kind"]) => {
    if (!editor || kind === editor.kind) return;
    if (dirty && !window.confirm("Discard the text you entered?")) return;
    dispatch({ type: "sourceSwitched", kind });
  };
  const cancel = () => {
    if (dirty && !window.confirm("Discard your unsaved skill changes?")) return;
    dispatch({ type: "cancelled" }); pendingFocus.current = true;
  };
  const back = () => { dispatch({ type: "listOpened" }); pendingFocus.current = true; };
  const setReview = (kind: ReviewKind, checked: boolean) => dispatch({ type: "reviewChanged", kind, checked });
  const setDeleteConfirmation = (open: boolean) => dispatch({ type: "deleteConfirmationChanged", open });
  const reloadSkills = () => { dispatch({ type: "reloadRequested" }); void reload(); };
  const closeHistory = () => { dispatch({ type: "historyClosed" }); historyButton.current?.focus(); };

  const save = () => {
    if (conflict || !editor || !skillEditorComplete(editor) || (mode === "edit" && !dirty)) return;
    void run("save", async (current, trigger) => {
      const result = mode === "create"
        ? await createProjectSkill(scope.projectId, { scope, source: skillEditorSource(editor) })
        : selected && await updateProjectSkill(scope.projectId, selected.id, { scope, source: skillEditorSource(editor), version: selected.version });
      if (!result || !current() || !check(result.scope)) return;
      dispatch({ type: "skillSaved", skill: result.skill });
      pendingFocus.current = document.activeElement === trigger;
    });
  };
  const act = (action: "release" | "disable") => {
    if (!selected || (action === "release" && !reviewed.release)) return;
    void run(action, async (current) => {
      const result = await actOnProjectSkill(scope.projectId, selected.id, { scope, version: selected.version, action });
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "skillActionSucceeded", action, skill: result.skill, projectName }); onChanged?.();
    });
  };
  const remove = () => {
    if (!selected || view.kind !== "details" || !view.confirmDelete) return;
    void run("delete", async (current, trigger) => {
      const result = await deleteProjectSkill(scope.projectId, selected.id, { scope, version: selected.version });
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "skillDeleted", skillId: selected.id }); onChanged?.(); pendingFocus.current = document.activeElement === trigger;
    });
  };
  const openCopy = () => void run("copy-list", async (current, trigger) => {
    const result = await getPersonalSkills();
    if (!current()) return;
    if (!samePersonalScope(result.scope)) { lock(); return; }
    dispatch({ type: "copyListLoaded", skills: result.skills }); pendingFocus.current = document.activeElement === trigger;
  });
  const chooseCopy = (id: string) => void run("copy-read", async (current) => {
    dispatch({ type: "copyCandidateRequested" });
    const result = await getPersonalSkill(id);
    if (!current()) return;
    if (!samePersonalScope(result.scope)) { lock(); return; }
    dispatch({ type: "copyCandidateLoaded", skill: result.skill });
  });
  const copy = () => {
    const candidate = copyCandidate, sourceRevision = candidate?.active?.revision;
    if (!candidate || sourceRevision === undefined || !reviewed.copy) return;
    void run("copy", async (current, trigger) => {
      const result = await copyPersonalSkillToProject(scope.projectId, { scope, personalSkillId: candidate.id, sourceRevision });
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "skillCopied", skill: result.skill }); pendingFocus.current = document.activeElement === trigger;
    });
  };
  const inspectSource = () => {
    const personalSkillId = selected?.copiedFrom?.mine ? selected.copiedFrom.personalSkillId : null;
    if (!personalSkillId) return;
    void run("source-read", async (current) => {
      dispatch({ type: "sourceRequested" });
      const result = await getPersonalSkill(personalSkillId);
      if (!current()) return;
      if (!samePersonalScope(result.scope)) { lock(); return; }
      dispatch({ type: "sourceLoaded", skill: result.skill });
    }, true);
  };
  const updateSource = () => {
    const sourceRevision = sourceCandidate?.active?.revision;
    if (!selected || sourceRevision === undefined || !reviewed.sourceUpdate) return;
    void run("source-update", async (current) => {
      const result = await updateProjectSkillFromPersonal(scope.projectId, selected.id, { scope, version: selected.version, sourceRevision });
      if (!current() || !check(result.scope)) return;
      dispatch({ type: "sourceUpdated", skill: result.skill, sourceRevision });
    });
  };
  const showHistory = () => {
    if (!selected) return;
    void run("history", async (current) => {
      const result = await getProjectSkillHistory(scope.projectId, selected.id);
      if (current() && check(result.scope)) dispatch({ type: "historyLoaded", skillId: selected.id, revisions: result.revisions });
    }, true);
  };
  const readFile = async (file?: File) => {
    if (!file || filePending.current || requestPending.current || !editable || readFailed) return;
    const number = ++fileRead.current, epoch = generation.current;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current && number === fileRead.current;
    filePending.current = true; dispatch({ type: "fileReadStarted" });
    try { const markdown = await readSkillMarkdownFile(file); if (current()) dispatch({ type: "fileReadSucceeded", markdown }); }
    catch (cause) { if (current()) dispatch({ type: "fileReadFailed", message: message(cause) }); }
    finally { if (current()) { filePending.current = false; dispatch({ type: "fileReadFinished" }); } }
  };

  return {
    heading, historyButton,
    mode, selected, editor, skills: list.skills, personal: state.personal, copyCandidate, sourceCandidate,
    history: state.history?.revisions ?? null, confirmDelete: view.kind === "details" && view.confirmDelete,
    loading, readFailed, pending, readingFile, busy, locked, expired: state.lock.locked && state.lock.expired,
    error: feedback.error, errorAt: feedback.errorAt, notice: feedback.notice, fileError: feedback.fileError,
    editable, disabled, actionDisabled, dirty, conflict, reviewed,
    beginCreate, openDetails, beginEdit, chooseLatestVersion, keepLocalText, changeDraft, switchSource, cancel, back,
    setReview, setDeleteConfirmation, reloadSkills, closeHistory, save, act, remove, openCopy, chooseCopy, copy,
    inspectSource, updateSource, showHistory, readFile
  };
}
