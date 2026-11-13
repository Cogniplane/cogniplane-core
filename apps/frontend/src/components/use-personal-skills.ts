"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PersonalSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import {
  actOnPersonalSkill, createPersonalSkill, deletePersonalSkill, getPersonalSkillHistory,
  getPersonalSkills, updatePersonalSkill
} from "@/lib/personal-skills-api";
import { readSkillMarkdownFile, skillEditorSource } from "./skill-editor-parts";
import {
  hasConflict, initialState, isDirty, isReviewed, personalSkillsReducer, selectedSkill,
  type ListRead, type LockReason, type Operation
} from "./personal-skills-state";

const message = (error: unknown) => error instanceof Error ? error.message : "The request failed. Try again.";
const lockReason = (cause: unknown): LockReason | null =>
  !(cause instanceof ApiError) ? null
    : cause.status === 401 ? "session_expired"
      : cause.code === "personal_skill_scope_changed" ? "scope_changed" : null;
// The skill changed or is gone. The editor reads the list again before the next write.
const needsReread = (cause: unknown) => cause instanceof ApiError &&
  ((cause.status === 409 && cause.code === "personal_skill_conflict") || cause.status === 404);

/**
 * Focus facts that the controller reads when a request starts and when it ends.
 * The component owns the elements. The controller keeps only the answers, and
 * the reducer turns them into focus requests.
 */
export type FocusProbe = {
  /** The element with focus when a request starts. */
  capture: () => Element | null;
  /** Focus is still on the trigger, or on no element. */
  owns: (trigger: Element | null) => boolean;
  /** Focus is on no element, on a skill action, or in the recovery notice. */
  ownsRecovery: () => boolean;
};

/**
 * Sends the requests of the private skill editor and reports their results to
 * the reducer. Refs block a second request in the same turn, before React renders.
 */
export function usePersonalSkills({ expectedScope, requestedSubmissionId, focusProbe, onChanged, onDirtyChange }: {
  expectedScope: PersonalSkillScope;
  requestedSubmissionId: string | null;
  focusProbe: FocusProbe;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, dispatch] = useReducer(personalSkillsReducer, Boolean(requestedSubmissionId), initialState);
  const gate = useRef({ request: false, file: false, list: true, locked: false });
  // A file read writes its result only while its number is current.
  const fileRead = useRef(0);
  const [submissionDirty, setSubmissionDirty] = useState(false);

  const lock = useCallback((reason: LockReason) => {
    gate.current.locked = true;
    gate.current.file = false;
    fileRead.current += 1;
    dispatch({ type: "locked", reason });
  }, []);
  const accept = useCallback((scope: PersonalSkillScope) => {
    if (scope.tenantId === expectedScope.tenantId && scope.userId === expectedScope.userId) return true;
    lock("scope_changed");
    return false;
  }, [expectedScope.tenantId, expectedScope.userId, lock]);
  const failRead = useCallback((cause: unknown) => {
    const reason = lockReason(cause);
    if (reason) lock(reason);
    else dispatch({ type: "listFailed", error: message(cause) });
  }, [lock]);

  useEffect(() => {
    let active = true;
    const gates = gate.current;
    const files = fileRead;
    gates.list = true;
    getPersonalSkills().then((result) => {
      if (active && accept(result.scope)) dispatch({ type: "listLoaded", skills: result.skills, read: "initial", focusHere: false });
    }).catch((cause: unknown) => { if (active) failRead(cause); })
      .finally(() => { if (active) gates.list = false; });
    // Unmount drops the initial read and any file read.
    return () => { active = false; files.current += 1; };
  }, [accept, failRead]);

  const active = state.status === "active" ? state : null;
  const view = active?.view ?? null;
  const selected = active ? selectedSkill(active) : null;
  const conflict = active ? hasConflict(active) : false;
  const reviewed = active ? isReviewed(active) : false;
  const dirty = view ? isDirty(view) : false;
  const readingFile = active?.readingFile ?? false;
  // A lock hides everything. A requested submission comes before the local view.
  const visible = !view ? "locked" : requestedSubmissionId ? "submissions" : view.kind;
  useEffect(() => {
    onDirtyChange?.(dirty || readingFile || (visible === "submissions" && submissionDirty));
  }, [dirty, readingFile, visible, submissionDirty, onDirtyChange]);

  const readList = async (read: Exclude<ListRead, "initial">) => {
    const trigger = focusProbe.capture();
    gate.current.list = true;
    dispatch({ type: "listStarted" });
    try {
      const result = await getPersonalSkills();
      if (!accept(result.scope)) return;
      const focusHere = read === "list" ? focusProbe.owns(trigger) : focusProbe.ownsRecovery();
      dispatch({ type: "listLoaded", skills: result.skills, read, focusHere });
    } catch (cause) {
      failRead(cause);
    } finally { gate.current.list = false; }
  };

  /** `target` is the skill the request writes or reads. A conflict starts a recovery for it. */
  const run = async (operation: Operation, target: string | null, work: (trigger: Element | null) => Promise<void>) => {
    const gates = gate.current;
    if (gates.request || gates.file || gates.list || gates.locked) return;
    gates.request = true;
    const trigger = focusProbe.capture();
    dispatch({ type: "requestStarted", operation });
    try { await work(trigger); } catch (cause) {
      const reason = lockReason(cause);
      if (needsReread(cause)) {
        if (target) {
          dispatch({ type: "writeConflicted", skillId: target, reason: message(cause), focusHere: focusProbe.owns(trigger) });
          // The reread stays inside this request, so its trigger keeps the pending label.
          await readList("recovery");
        }
      } else if (reason) lock(reason);
      else dispatch({ type: "requestFailed", operation, message: message(cause), reveal: focusProbe.owns(trigger) });
    } finally {
      gates.request = false;
      dispatch({ type: "requestFinished" });
    }
  };

  const reloadList = () => {
    const gates = gate.current;
    if (gates.list || gates.request || gates.file || gates.locked) return;
    void readList("list");
  };
  const reloadLatest = () => { void run("latest", null, () => readList("recovery")); };

  const save = () => {
    if (!view || (view.kind !== "create" && view.kind !== "edit") || active?.recovery || conflict) return;
    const source = skillEditorSource(view.editor);
    const base = view.kind === "edit" ? { skillId: view.skillId, version: view.version } : null;
    void run("save", base?.skillId ?? null, async (trigger) => {
      const result = base
        ? await updatePersonalSkill(base.skillId, { scope: expectedScope, source, version: base.version })
        : await createPersonalSkill({ scope: expectedScope, source });
      if (accept(result.scope)) dispatch({ type: "saved", skill: result.skill, focusHere: focusProbe.owns(trigger) });
    });
  };
  const act = (action: "release" | "disable") => {
    const skill = selected;
    if (!skill || active?.recovery || (action === "release" && !reviewed)) return;
    void run(action, skill.id, async (trigger) => {
      const result = await actOnPersonalSkill(skill.id, { scope: expectedScope, version: skill.version, action });
      if (!accept(result.scope)) return;
      dispatch({ type: "acted", skill: result.skill, action, focusHere: focusProbe.owns(trigger) });
      // The parent refreshes chat defaults. It needs this even after the editor unmounts.
      onChanged?.();
    });
  };
  const remove = () => {
    const skill = selected;
    if (!skill || (view?.kind !== "details" && view?.kind !== "review") || !view.confirmDelete || active?.recovery) return;
    void run("delete", skill.id, async (trigger) => {
      const result = await deletePersonalSkill(skill.id, { scope: expectedScope, version: skill.version });
      if (!accept(result.scope)) return;
      dispatch({ type: "deleted", skillId: skill.id, focusHere: focusProbe.owns(trigger) });
      onChanged?.();
    });
  };
  const toggleHistory = () => {
    const skill = selected;
    if (!skill || (view?.kind !== "details" && view?.kind !== "review")) return;
    if (view.historyOpen || view.history) { dispatch({ type: "historyToggled" }); return; }
    void run("history", skill.id, async (trigger) => {
      const result = await getPersonalSkillHistory(skill.id);
      if (accept(result.scope)) dispatch({ type: "historyLoaded", skillId: skill.id, revisions: result.revisions, reveal: focusProbe.owns(trigger) });
    });
  };
  /** Returns false when another request or file read blocks this one. */
  const readFile = (file?: File) => {
    const gates = gate.current;
    if (!file || gates.file || gates.request || gates.locked) return false;
    gates.file = true;
    const read = ++fileRead.current;
    dispatch({ type: "fileStarted" });
    void readSkillMarkdownFile(file).then(
      (markdown) => { if (read === fileRead.current) dispatch({ type: "fileLoaded", markdown }); },
      (cause: unknown) => { if (read === fileRead.current) dispatch({ type: "fileFailed", error: message(cause) }); }
    ).finally(() => { if (read === fileRead.current) gates.file = false; });
    return true;
  };

  return {
    state, dispatch, visible, selected, conflict, reviewed, dirty, readingFile,
    save, act, remove, toggleHistory, readFile, reloadList, reloadLatest, setSubmissionDirty
  };
}
