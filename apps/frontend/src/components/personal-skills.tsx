"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import type { PersonalSkill, PersonalSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import {
  actOnPersonalSkill, createPersonalSkill, deletePersonalSkill, getPersonalSkillHistory,
  getPersonalSkills, updatePersonalSkill
} from "@/lib/personal-skills-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { OrganizationSkillSubmissions } from "./organization-skill-submissions";
import {
  emptySkillContent as emptyContent, readSkillMarkdownFile, skillEditorComplete, skillEditorSource as source,
  SkillConflictChoice, skillFocusRing, SkillHistory, SkillInstructions, SkillNotice, SkillSourceFields, SkillValidation,
  type SkillEditorState as Editor
} from "./skill-editor-parts";

type Mode = "list" | "create" | "edit" | "review" | "details" | "submissions";
type Operation = "save" | "release" | "disable" | "delete" | "history" | "latest";
type Block = Exclude<Operation, "latest">;
// A write failed because the skill changed or is gone, and no list read has confirmed it since.
// All writes stay blocked until a full list read succeeds. Navigation does not clear it.
type Recovery = { id: string; reason: string };
// A failed write or read shows at the control that started it.
type ActionError = { operation: Operation; tone: "danger" | "attention"; title: string; detail: string };
// A result for the whole view: a confirmed write, or a skill deleted elsewhere.
type Notice = { tone: "success" | "attention"; title: string; detail?: string };
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed. Try again.";
const locks = (cause: unknown): cause is ApiError =>
  cause instanceof ApiError && (cause.status === 401 || cause.code === "personal_skill_scope_changed");
const headingFocus = `-mx-1 rounded-sm px-1 ${skillFocusRing}`;
// 64ch of Inter holds about 70 characters of running text.
const prose = "max-w-[64ch]";
const quietDisabled = "disabled:border disabled:border-outline-variant disabled:bg-surface-container disabled:text-on-surface-variant";

// Revision words follow personal-skill-store. Release makes the latest revision
// the active one and turns the skill on. Turn off keeps the active revision but
// stops its use. Save adds a draft and does not change the active revision.
const status = (skill: PersonalSkill) => skill.enabled && skill.active ? "In use" : skill.active ? "Off" : "Draft";
const hasNewDraft = (skill: PersonalSkill) => skill.latest.revision !== skill.active?.revision;
const inChats = (skill: PersonalSkill) => !skill.active ? "Nothing yet. No revision is released."
  : skill.enabled ? `Revision ${skill.active.revision}` : `Nothing. Revision ${skill.active.revision} is off.`;
const shown = (skill: PersonalSkill) => hasNewDraft(skill) ? `Draft revision ${skill.latest.revision}, not released`
  : `Revision ${skill.latest.revision}, ${skill.enabled ? "in use" : "off"}`;
function releaseCopy(skill: PersonalSkill) {
  const next = skill.latest.revision, current = skill.active?.revision;
  if (current === next) return {
    heading: skill.enabled ? `Revision ${next} is in use` : `Make revision ${next} available again`,
    effect: `Release makes revision ${next} the revision in use again.`
  };
  return {
    heading: `Review draft revision ${next}`,
    effect: current == null ? `Release makes revision ${next} the revision in use.`
      : skill.enabled ? `Release replaces revision ${current} with revision ${next} as the revision in use.`
        : `Release replaces revision ${current}, which is off, with revision ${next} as the revision in use.`
  };
}

function Pending({ active, idle, busy }: { active: boolean; idle: string; busy: string }) {
  return active ? <><LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{busy}</> : <>{idle}</>;
}

export function PersonalSkills({ expectedScope, requestedSubmissionId = null, onChanged, onDirtyChange, onSubmissionPendingChange }: {
  expectedScope: PersonalSkillScope;
  requestedSubmissionId?: string | null;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmissionPendingChange?: (pending: boolean) => void;
}) {
  const [skills, setSkills] = useState<PersonalSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(requestedSubmissionId ? "submissions" : "list");
  const [editor, setEditor] = useState<Editor>({ kind: "inline", content: emptyContent });
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Operation | null>(null);
  const busy = pending !== null;
  const requestPending = useRef(false);
  const fileRead = useRef(0);
  const filePending = useRef(false);
  const [readingFile, setReadingFile] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [scopeMismatch, setScopeMismatch] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const visibleMode = scopeMismatch ? "list" : requestedSubmissionId ? "submissions" : mode;
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getPersonalSkillHistory>>["revisions"] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [discard, setDiscard] = useState<"cancel" | Editor["kind"] | null>(null);
  const discardedView = useRef(false);
  // Set after a save conflict. Save stays blocked until the user keeps their text or takes the latest version.
  const [conflictSkillId, setConflictSkillId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [listReadError, setListReadError] = useState<string | null>(null);
  const listReadFailed = listReadError !== null;
  const [submissionDirty, setSubmissionDirty] = useState(false);
  const [submissionSourceId, setSubmissionSourceId] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const pendingViewFocus = useRef(false);
  const pendingDeleteFocus = useRef<"confirm" | "restore" | null>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const pendingRecoveryFocus = useRef(false);
  const conflictRef = useRef<HTMLDivElement>(null);
  const pendingConflictFocus = useRef(false);
  const fileStatusRef = useRef<HTMLParagraphElement>(null);
  const pendingFileFocus = useRef(false);
  // The decision block of each operation: its trigger, its consequence and its result.
  const saveBlock = useRef<HTMLDivElement>(null), releaseBlock = useRef<HTMLDivElement>(null);
  const disableBlock = useRef<HTMLDivElement>(null), deleteBlock = useRef<HTMLDivElement>(null), historyBlock = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<{ operation: Block; trigger: Element | null } | null>(null);
  const selected = useMemo(() => skills.find((item) => item.id === selectedId) ?? null, [skills, selectedId]);
  const dirty = (mode === "create" || mode === "edit") && JSON.stringify(editor) !== baseline;
  const conflict = mode === "edit" && selected && conflictSkillId === selected.id ? selected : null;
  // Keep the tab guard in sync with local edits, including edits loaded from a file.
  useEffect(() => { onDirtyChange?.(dirty || readingFile || (visibleMode === "submissions" && submissionDirty)); }, [dirty, readingFile, visibleMode, submissionDirty, onDirtyChange]);
  useLayoutEffect(() => {
    if (!pendingViewFocus.current) return;
    const target = (visibleMode === "list" ? listHeadingRef : viewHeadingRef).current;
    if (!target) return;
    pendingViewFocus.current = false;
    target.focus();
  }, [visibleMode, selectedId, skills, conflictSkillId]);
  useLayoutEffect(() => {
    if (!pendingDeleteFocus.current) return;
    const target = pendingDeleteFocus.current;
    pendingDeleteFocus.current = null;
    const button = (target === "confirm" ? deleteConfirmRef : deleteTriggerRef).current;
    if (button?.disabled) recoveryRef.current?.focus();
    else button?.focus();
  }, [confirmDelete]);
  useLayoutEffect(() => {
    if (!recovery || !pendingRecoveryFocus.current) return;
    pendingRecoveryFocus.current = false;
    recoveryRef.current?.focus();
  }, [recovery]);
  useLayoutEffect(() => {
    if (!conflict || !pendingConflictFocus.current) return;
    pendingConflictFocus.current = false;
    conflictRef.current?.focus();
  }, [conflict]);
  useLayoutEffect(() => {
    if (!pendingFileFocus.current) return;
    if (readingFile) fileStatusRef.current?.focus();
    else {
      pendingFileFocus.current = false;
      if (document.activeElement === document.body) document.getElementById("skill-file")?.focus({ preventScroll: true });
    }
  }, [readingFile]);
  // Bring a result into view next to its trigger, but only while that trigger still has focus.
  useLayoutEffect(() => {
    const reveal = pendingReveal.current;
    if (!reveal) return;
    pendingReveal.current = null;
    if (!reveal.trigger || document.activeElement !== reveal.trigger) return;
    const blocks = { save: saveBlock, release: releaseBlock, disable: disableBlock, delete: deleteBlock, history: historyBlock };
    blocks[reveal.operation].current?.scrollIntoView?.({ block: "nearest" });
  }, [actionError, historyOpen]);

  const lockScope = useCallback((expired = false) => {
    pendingViewFocus.current = true;
    setScopeMismatch(true);
    setSessionExpired(expired);
    setSkills([]);
    setSelectedId(null);
    setEditor({ kind: "inline", content: emptyContent });
    setMode("list");
    setActionError(null);
    setNotice(null);
    setFileError(null);
    setListReadError(null);
    setReviewedRevision(null);
    setHistory(null);
    setHistoryOpen(false);
    setConfirmDelete(false);
    setDiscard(null);
    setConflictSkillId(null);
    setRecovery(null);
    setBaseline("");
    fileRead.current += 1;
    filePending.current = false;
    setReadingFile(false);
    pendingFileFocus.current = false;
  }, []);
  const checkScope = useCallback((scope: PersonalSkillScope) => {
    if (scope.tenantId === expectedScope.tenantId && scope.userId === expectedScope.userId) return true;
    lockScope();
    return false;
  }, [expectedScope.tenantId, expectedScope.userId, lockScope]);
  const readFailed = useCallback((cause: unknown) => {
    if (locks(cause)) lockScope(cause.status === 401);
    else setListReadError(message(cause));
  }, [lockScope]);
  const reload = useCallback(async (keepEditor = false) => {
    if (scopeMismatch) return null;
    const trigger = document.activeElement;
    setLoading(true);
    try {
      const result = await getPersonalSkills();
      if (!checkScope(result.scope)) return null;
      setSkills(result.skills);
      setListReadError(null);
      setHistory(null);
      setHistoryOpen(false);
      if (!keepEditor) {
        setRecovery(null);
        setNotice(null);
        if (trigger === document.activeElement && trigger?.getAttribute("data-skill-action") === "reload") pendingViewFocus.current = true;
      }
      return result.skills;
    } catch (cause) {
      readFailed(cause);
      return null;
    } finally { setLoading(false); }
  }, [checkScope, readFailed, scopeMismatch]);
  useEffect(() => {
    let active = true;
    getPersonalSkills().then((result) => {
      if (!active || !checkScope(result.scope)) return;
      setSkills(result.skills);
      setListReadError(null);
    }).catch((cause: unknown) => { if (active) readFailed(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; fileRead.current += 1; };
  }, [checkScope, readFailed]);
  // Leaving a view drops its results, so a message never describes another skill.
  const leaveView = () => {
    setActionError(null); setNotice(null); setFileError(null);
    setReviewedRevision(null); setConfirmDelete(false); setHistory(null); setHistoryOpen(false);
  };
  const replaceSkill = (skill: PersonalSkill) => {
    setSkills((current) => [...current.filter((item) => item.id !== skill.id), skill]
      .sort((a, b) => a.latest.content.name.localeCompare(b.latest.content.name)));
    setSelectedId(skill.id);
    setHistory(null);
    setHistoryOpen(false);
  };
  const beginCreate = () => {
    if (recovery) return;
    pendingViewFocus.current = true;
    const next: Editor = { kind: "inline", content: { ...emptyContent } };
    leaveView();
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(null);
    setMode("create"); setConflictSkillId(null);
  };
  const beginEdit = (skill: PersonalSkill) => {
    if (recovery) return;
    pendingViewFocus.current = true;
    const next: Editor = { kind: "inline", content: { ...skill.latest.content } };
    leaveView();
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(skill.id);
    setMode("edit"); setConflictSkillId(null);
  };
  const openSkill = (skill: PersonalSkill, next: "details" | "review") => {
    pendingViewFocus.current = true;
    leaveView();
    setSelectedId(skill.id); setMode(next);
  };
  const backToList = () => {
    pendingViewFocus.current = true;
    leaveView();
    setMode("list"); setSelectedId(null);
  };
  const leaveEditor = () => {
    pendingViewFocus.current = true;
    leaveView();
    setMode(selectedId ? "details" : "list"); setConflictSkillId(null);
  };
  const cancelEdit = () => { if (dirty) setDiscard("cancel"); else leaveEditor(); };
  const recoverLatest = async (target: Recovery) => {
    const reloaded = await reload(true);
    if (!reloaded) return;
    setRecovery(null);
    // Navigation is blocked while the read runs, so the view is the one that started it.
    const editing = mode === "edit" && selectedId === target.id;
    const viewing = (mode === "details" || mode === "review") && selectedId === target.id;
    const stillHere = document.activeElement === document.body ||
      document.activeElement?.hasAttribute("data-skill-action") ||
      recoveryRef.current?.contains(document.activeElement);
    if (!reloaded.some((item) => item.id === target.id) && (editing || viewing)) {
      pendingViewFocus.current = true;
      setSelectedId(null); setConfirmDelete(false);
      setMode(editing ? "create" : "list");
      setNotice({ tone: "attention", title: "This skill was deleted elsewhere", detail: editing
        ? "Your text is still here. Save it as a new draft if you want to keep it."
        : "It is no longer in your list." });
    } else if (editing) {
      pendingConflictFocus.current = Boolean(stillHere);
      setConflictSkillId(target.id);
      setActionError(null);
    } else {
      if (stillHere) pendingViewFocus.current = true;
      if (viewing) setNotice({ tone: "attention", title: "This skill changed elsewhere", detail: `${target.reason} Review the current version before you try again.` });
    }
  };
  const failure = (operation: Operation) => ({
    save: "Draft not saved",
    release: selected ? `Could not make revision ${selected.latest.revision} available` : "Could not make the revision available",
    disable: `Could not turn off ${selected?.latest.content.name ?? "this skill"}`,
    delete: `Could not delete ${selected?.latest.content.name ?? "this skill"}`,
    history: "Could not load revision history",
    latest: "Could not reload the latest version"
  })[operation];
  const ownsFocus = (trigger: Element | null) => document.activeElement === trigger || document.activeElement === document.body;
  const run = async (operation: Operation, work: (trigger: Element | null) => Promise<void>) => {
    if (requestPending.current || filePending.current || loading || readingFile || scopeMismatch) return;
    requestPending.current = true;
    const trigger = document.activeElement;
    setPending(operation); setActionError(null);
    if (operation !== "history") setNotice(null);
    try { await work(trigger); } catch (cause) {
      if (cause instanceof ApiError && ((cause.status === 409 && cause.code === "personal_skill_conflict") || cause.status === 404)) {
        setReviewedRevision(null);
        if (selectedId) {
          const target = { id: selectedId, reason: message(cause) };
          pendingRecoveryFocus.current = document.activeElement === document.body || document.activeElement?.getAttribute("data-skill-action") === operation;
          setRecovery(target);
          await recoverLatest(target);
        }
      } else if (locks(cause)) lockScope(cause.status === 401);
      else {
        if (operation !== "latest") pendingReveal.current = { operation, trigger };
        setActionError({ operation, tone: "danger", title: failure(operation),
          detail: operation === "save" ? `${message(cause)} Your text is still here.` : message(cause) });
      }
    } finally { requestPending.current = false; setPending(null); }
  };
  const save = () => { if (recovery || conflict) return; void run("save", async (trigger) => {
    const payload = source(editor);
    const result = mode === "create"
      ? await createPersonalSkill({ scope: expectedScope, source: payload })
      : selected && await updatePersonalSkill(selected.id, { scope: expectedScope, source: payload, version: selected.version });
    if (!result || !checkScope(result.scope)) return;
    pendingViewFocus.current = ownsFocus(trigger);
    replaceSkill(result.skill); setMode("review"); setReviewedRevision(null);
    setBaseline(JSON.stringify(editor));
  }); };
  const act = (action: "release" | "disable") => {
    if (!selected || recovery || (action === "release" && reviewedRevision !== selected.latest.revision)) return;
    void run(action, async (trigger) => {
      const result = await actOnPersonalSkill(selected.id, { scope: expectedScope, version: selected.version, action });
      if (!checkScope(result.scope)) return;
      pendingViewFocus.current = ownsFocus(trigger);
      replaceSkill(result.skill); setMode("details"); setReviewedRevision(null);
      const { name } = result.skill.latest.content;
      setNotice(action === "release"
        ? { tone: "success", title: `Revision ${result.skill.active?.revision ?? result.skill.latest.revision} is in use`, detail: `${name} is available for your chats.` }
        : { tone: "success", title: `${name} is off`, detail: "It is not available for your chats. Its revisions stay saved." });
      onChanged?.();
    });
  };
  const remove = () => {
    if (!selected || !confirmDelete || recovery) return;
    void run("delete", async (trigger) => {
      const result = await deletePersonalSkill(selected.id, { scope: expectedScope, version: selected.version });
      if (!checkScope(result.scope)) return;
      pendingViewFocus.current = ownsFocus(trigger);
      setSkills((current) => current.filter((item) => item.id !== selected.id));
      setSelectedId(null); setMode("list"); setConfirmDelete(false); setHistory(null); setHistoryOpen(false);
      setNotice({ tone: "success", title: `Deleted ${selected.latest.content.name} and its revision history` });
      onChanged?.();
    });
  };
  const toggleHistory = () => {
    if (!selected) return;
    if (historyOpen) { setHistoryOpen(false); return; }
    if (history) {
      pendingReveal.current = { operation: "history", trigger: document.activeElement };
      setHistoryOpen(true);
      return;
    }
    void run("history", async (trigger) => {
      const result = await getPersonalSkillHistory(selected.id);
      if (!checkScope(result.scope)) return;
      pendingReveal.current = { operation: "history", trigger };
      setHistory(result.revisions);
      setHistoryOpen(true);
    });
  };
  const changeSource = (kind: Editor["kind"]) => {
    const next: Editor = kind === "inline" ? { kind, content: { ...emptyContent } } : { kind, markdown: "" };
    setEditor(next); setBaseline(JSON.stringify(next)); setFileError(null); setActionError(null);
  };
  const switchEditor = (kind: Editor["kind"]) => {
    if (kind === editor.kind) return;
    if (dirty) setDiscard(kind); else changeSource(kind);
  };
  const readFile = async (file?: File) => {
    if (!file || filePending.current || requestPending.current || scopeMismatch) return;
    filePending.current = true;
    pendingFileFocus.current = document.activeElement === document.getElementById("skill-file");
    const read = ++fileRead.current;
    setReadingFile(true);
    setFileError(null);
    try {
      const markdown = await readSkillMarkdownFile(file);
      if (read !== fileRead.current) return;
      setEditor({ kind: "markdown", markdown });
    } catch (cause) { if (read === fileRead.current) setFileError(message(cause)); }
    finally { if (read === fileRead.current) { filePending.current = false; setReadingFile(false); } }
  };
  const disabled = busy || loading || readingFile || scopeMismatch;
  // The trigger names its own failure, so the error is not only an announcement.
  const errorId = (operation: Operation) => `private-skill-error-${operation}`;
  const describedBy = (operation: Operation) => actionError?.operation === operation ? errorId(operation) : undefined;
  const errorFor = (operation: Operation, inline = false): ReactNode => {
    if (actionError?.operation !== operation) return null;
    if (inline) return <div id={errorId(operation)} role="alert" className={`flex items-start gap-2 border-t border-danger/30 pt-3 ${prose}`}><CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" /><p><strong className="font-semibold">{actionError.title}.</strong> {actionError.detail}</p></div>;
    return <SkillNotice id={errorId(operation)} role="alert" tone={actionError.tone} title={actionError.title}><p className={prose}>{actionError.detail}</p></SkillNotice>;
  };
  const viewNotice = notice ? <SkillNotice role={notice.tone === "success" ? "status" : "alert"} tone={notice.tone} title={notice.title}>{notice.detail ? <p className={prose}>{notice.detail}</p> : null}</SkillNotice> : null;
  const recoveryBlock = recovery ? <SkillNotice ref={recoveryRef} tabIndex={-1} role="group" aria-label="Reload current skill" tone="danger" title="The current version could not be confirmed">
    {listReadError ? <p className={prose}>{listReadError}</p> : null}
    <p className={prose}>{recovery.reason}</p>
    <p className={prose}>{mode === "edit" || mode === "create" ? "Your unsaved text is still here. " : ""}Reload the latest version before saving, releasing, turning off, or deleting this skill.</p>
    <Button data-skill-action="latest" size="sm" variant="outline" aria-disabled={pending === "latest"} disabled={disabled && pending !== "latest"} onClick={() => void run("latest", () => recoverLatest(recovery))}><Pending active={pending === "latest"} idle="Reload latest version" busy="Reloading latest version…" /></Button>
  </SkillNotice> : null;
  const saveNote = mode === "create" || !selected?.active ? "Saving a draft does not make it available in chats. You review it before release."
    : selected.enabled ? `Saving creates a new draft. Revision ${selected.active.revision} stays in use until you release the draft.`
      : "Saving creates a new draft. This skill stays off until you release a revision.";
  const historyId = selected ? `private-skill-history-${selected.id}` : undefined;
  const name = selected?.latest.content.name ?? "";
  const revision = selected?.latest.revision ?? 0;
  const release = selected ? releaseCopy(selected) : null;
  const releasable = Boolean(selected && (mode === "review" || !selected.enabled || hasNewDraft(selected)));

  return <section aria-labelledby={visibleMode === "submissions" ? "submission-title" : "private-skills-title"} className="space-y-5 pt-5 [overflow-wrap:anywhere]">
    {visibleMode === "submissions" && !scopeMismatch ? <OrganizationSkillSubmissions expectedScope={expectedScope} skills={skills} initialSkillId={submissionSourceId} requestedSubmissionId={requestedSubmissionId} onDirtyChange={setSubmissionDirty} onPendingChange={onSubmissionPendingChange} onBack={() => { setMode("list"); setSubmissionSourceId(null); pendingViewFocus.current = true; }} /> : null}
    {visibleMode !== "submissions" ? <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2">
        <h2 ref={listHeadingRef} tabIndex={-1} id="private-skills-title" className={`text-base font-semibold text-on-surface ${headingFocus}`}>Private skills</h2>
        <p className="text-sm text-on-surface-variant">Write or import instructions for your own standalone chats. Only you can use these skills. Projects and scheduled jobs do not use them.</p>
      </div>
      {mode === "list" ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => { leaveView(); setSubmissionSourceId(null); setMode("submissions"); }}>My submissions</Button><Button size="sm" className={quietDisabled} disabled={disabled || Boolean(recovery)} onClick={beginCreate}>Create skill</Button></div> : null}
    </div>
    {scopeMismatch ? <SkillNotice role="alert" tone="danger" title={sessionExpired ? "Your session expired" : "Your account or organization changed"}>
      <p>{sessionExpired ? "Reload this page to sign in again." : "Reload this page before editing private skills."}</p>
      <p>Unsaved text was cleared to protect your private skills.</p>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
    </SkillNotice> : null}
    {mode === "list" && !scopeMismatch ? <>
      {viewNotice}
      {listReadError ? null : recoveryBlock}
      {listReadError ? <SkillNotice role="alert" tone="danger" title={skills.length > 0 ? "Could not load the full skills list" : "Could not load private skills"}>
        <p className={prose}>{listReadError}</p>
        {recovery ? <p className={prose}>Reload skills before you create or change a skill.</p> : null}
        <Button data-skill-action="reload" size="sm" variant="outline" aria-disabled={loading} disabled={busy || readingFile || scopeMismatch} onClick={() => { if (!loading) void reload(); }}><Pending active={loading} idle="Reload skills" busy="Reloading skills…" /></Button>
        {skills.length > 0 ? <p role={loading ? "status" : undefined} className={prose}>{loading ? "Reloading skills. The list below shows the last confirmed items." : "Only skills confirmed in this session are shown below."}</p> : null}
      </SkillNotice> : null}
      {loading && skills.length > 0 && !listReadError ? <p role="status" className="text-sm text-on-surface-variant">Reloading skills. The list below shows the last confirmed items.</p> : null}
      {loading && skills.length === 0 ? <div className="space-y-2"><p role="status" className="flex items-center gap-2 text-sm text-on-surface-variant"><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Loading private skills…</p><div aria-hidden="true" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div></div> : null}
      {!loading && !listReadFailed && skills.length === 0
        ? <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-6 text-sm text-on-surface-variant">No private skills saved. Create one, then review it before making it available in your chats.</div> : null}
      {skills.length > 0 ? <ul aria-busy={loading} className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">{skills.map((skill) => {
        const editable = skill.active && !hasNewDraft(skill);
        return <li key={skill.id} className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1 basis-60 space-y-1">
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-on-surface">{skill.latest.content.name}</h3><span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">{status(skill)}</span>{skill.active && hasNewDraft(skill) ? <span className="text-xs text-on-surface-variant">Draft revision {skill.latest.revision} to review</span> : null}</div>
            {/* Two lines in the list. Details show the full purpose. */}
            <p className={`line-clamp-2 whitespace-pre-wrap text-sm text-on-surface-variant ${prose}`}>{skill.latest.content.description}</p>
          </div>
          <div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => openSkill(skill, "details")}>Details</Button><Button size="sm" className={quietDisabled} disabled={disabled || Boolean(editable && recovery)} onClick={() => editable ? beginEdit(skill) : openSkill(skill, "review")}>{editable ? "Edit" : "Review"}</Button></div>
        </li>;
      })}</ul> : null}
    </> : null}
    {(mode === "create" || mode === "edit") && !scopeMismatch ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={viewHeadingRef} tabIndex={-1} className={`font-semibold ${headingFocus}`}>{mode === "create" ? "Create a draft" : `Edit ${selected?.latest.content.name ?? "skill"}`}</h3><Button size="sm" variant="ghost" disabled={disabled} onClick={cancelEdit}>Cancel</Button></div>
      {viewNotice}
      {readingFile ? <p ref={fileStatusRef} tabIndex={-1} role="status" className={`text-sm text-on-surface-variant ${headingFocus}`}>Reading SKILL.md…</p> : null}
      <SkillSourceFields idPrefix="skill" editor={editor} disabled={disabled} onChange={setEditor} onSwitch={switchEditor} onFile={(file) => void readFile(file)}
        fileMessage={fileError ? <SkillNotice role="alert" tone="danger" title="Could not use this file"><p>{fileError}</p></SkillNotice> : null} />
      {recoveryBlock}
      {conflict ? <div ref={conflictRef} tabIndex={-1} className={`rounded-md ${skillFocusRing}`}><SkillConflictChoice content={conflict.latest.content} explanation="Your draft was not saved. Your unsaved text is still here. Compare it with the saved version, then choose which one to keep." disabled={disabled} onKeep={() => { setConflictSkillId(null); setActionError(null); pendingViewFocus.current = true; }} onUseLatest={() => beginEdit(conflict)} /></div> : null}
      <div ref={saveBlock} className="space-y-3 border-t border-outline-variant pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><Button className={quietDisabled} data-skill-action="save" aria-describedby={describedBy("save")} size="sm" aria-disabled={pending === "save"} disabled={(disabled && pending !== "save") || Boolean(conflict) || Boolean(recovery) || !skillEditorComplete(editor) || (mode === "edit" && !dirty)} onClick={save}><Pending active={pending === "save"} idle="Save draft" busy="Saving draft…" /></Button><span className={`text-sm text-on-surface-variant ${prose}`}>{saveNote}</span></div>
        {errorFor("save")}
      </div>
    </div> : null}
    {(mode === "review" || mode === "details") && selected && release && !scopeMismatch ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1"><h3 ref={viewHeadingRef} tabIndex={-1} className={`text-lg font-semibold ${headingFocus}`}>{name}</h3><p className={`whitespace-pre-wrap text-sm text-on-surface-variant ${prose}`}>{selected.latest.content.description}</p></div>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={backToList}>Back to skills</Button>
        </div>
        {/* A result sits next to the heading that receives focus. */}
        {viewNotice}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-on-surface-variant">In your chats</dt><dd className="font-medium text-on-surface">{inChats(selected)}</dd>
          <dt className="text-on-surface-variant">Shown below</dt><dd className="font-medium text-on-surface">{shown(selected)}</dd>
        </dl>
        {recoveryBlock}
        <SkillInstructions title={`Instructions in ${hasNewDraft(selected) ? "draft " : ""}revision ${revision}`} text={selected.latest.content.instructions} />
        <SkillValidation messages={selected.latest.validationMessages} />
        {releasable ? <div ref={releaseBlock} role="group" aria-labelledby="private-skill-release-title" className="space-y-3 border-t border-outline-variant pt-5">
          <h4 id="private-skill-release-title" className="text-sm font-semibold">{release.heading}</h4>
          <p className={`text-sm text-on-surface-variant ${prose}`}>{release.effect} After release, this skill is in your chat defaults. Chats with a saved skill selection need you to add it there too.</p>
          <label className="flex min-h-10 items-start gap-2 py-2 text-sm"><span className="relative mt-0.5 inline-flex size-4 shrink-0"><input type="checkbox" className={`peer size-4 appearance-none rounded-sm border border-input bg-control checked:border-primary checked:bg-primary disabled:opacity-50 ${skillFocusRing}`} checked={reviewedRevision === revision} disabled={disabled} onChange={(event) => setReviewedRevision(event.target.checked ? revision : null)} /><CheckIcon aria-hidden="true" className="pointer-events-none absolute inset-0 hidden size-4 text-primary-foreground peer-checked:block" /></span><span>I reviewed revision {revision} and its validation messages.</span></label>
          <Button size="sm" className={quietDisabled} data-skill-action="release" aria-describedby={describedBy("release")} aria-disabled={pending === "release"} disabled={(disabled && pending !== "release") || Boolean(recovery) || reviewedRevision !== revision} onClick={() => act("release")}><Pending active={pending === "release"} idle={`Make revision ${revision} available${selected.active?.revision === revision && !selected.enabled ? " again" : ""}`} busy={`Making revision ${revision} available…`} /></Button>
          {errorFor("release")}
        </div> : null}
        <div ref={historyBlock} className="space-y-3 border-t border-outline-variant pt-5">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={disabled || Boolean(recovery)} onClick={() => beginEdit(selected)}>Edit</Button>
            <Button data-skill-action="history" aria-describedby={describedBy("history")} size="sm" variant="outline" aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} aria-disabled={pending === "history"} disabled={disabled && pending !== "history"} onClick={toggleHistory}>
              {pending === "history" ? <Pending active idle="History" busy="Loading history…" /> : <>History<ChevronDownIcon aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${historyOpen ? "rotate-180" : ""}`} /></>}
            </Button>
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => { leaveView(); setSubmissionSourceId(selected.id); setMode("submissions"); }}>Share with organization</Button>
          </div>
          {errorFor("history")}
          {historyOpen && history ? <SkillHistory id={historyId} revisions={history} markers={(item) => [
            ...(item.revision === selected.active?.revision ? [selected.enabled ? "In use" : "Off"] : []),
            ...(item.revision === revision && hasNewDraft(selected) ? ["Latest draft"] : [])
          ]} /> : null}
        </div>
        <div className="divide-y divide-outline-variant border-t border-outline-variant">
          {selected.enabled && selected.active ? <div ref={disableBlock} className="space-y-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><p className={`min-w-0 flex-1 basis-56 text-sm text-on-surface-variant ${prose}`}>Turn off makes this skill unavailable for your chats. Revision {selected.active.revision} stays saved, and you can make a revision available again later.</p><Button data-skill-action="disable" aria-describedby={describedBy("disable")} size="sm" variant="outline" aria-disabled={pending === "disable"} disabled={(disabled && pending !== "disable") || Boolean(recovery)} onClick={() => act("disable")}><Pending active={pending === "disable"} idle="Turn off" busy="Turning off…" /></Button></div>
            {errorFor("disable")}
          </div> : null}
          <div ref={deleteBlock} className="space-y-3 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><p className={`min-w-0 flex-1 basis-56 text-sm text-on-surface-variant ${prose}`}>Delete removes this skill and all its revisions.</p><Button ref={deleteTriggerRef} size="sm" variant="outline" aria-expanded={confirmDelete} disabled={disabled || Boolean(recovery)} onClick={() => { pendingDeleteFocus.current = "confirm"; setConfirmDelete(true); }}>Delete</Button></div>
            {confirmDelete ? <SkillNotice role="group" aria-label="Confirm deletion" tone="danger" title={<>Delete <strong>{name}</strong>?</>}>
              <p className={prose}>This deletes its revision history and removes it from your skills and chat defaults. This cannot be undone.</p>
              <div className="flex flex-wrap gap-2"><Button ref={deleteConfirmRef} data-skill-action="delete" aria-describedby={describedBy("delete")} size="sm" variant="destructive" aria-disabled={pending === "delete"} disabled={(disabled && pending !== "delete") || Boolean(recovery)} onClick={remove}><Pending active={pending === "delete"} idle="Delete skill" busy="Deleting skill…" /></Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => { pendingDeleteFocus.current = "restore"; setConfirmDelete(false); setActionError(null); }}>Keep skill</Button></div>
              {errorFor("delete", true)}
            </SkillNotice> : null}
          </div>
        </div>
      </div> : null}
    <AlertDialog open={discard !== null} onOpenChange={(open) => { if (!open) setDiscard(null); }}>
      <AlertDialogContent onCloseAutoFocus={(event) => {
        if (discardedView.current || scopeMismatch) {
          event.preventDefault();
          discardedView.current = false;
          (selectedId ? viewHeadingRef : listHeadingRef).current?.focus();
        }
      }}>
        <AlertDialogHeader><AlertDialogTitle>Discard unsaved skill changes?</AlertDialogTitle><AlertDialogDescription>{discard === "cancel" ? "Your unsaved text will be removed. Saved revisions stay unchanged." : "Switching the source removes the text you entered. Saved revisions stay unchanged."}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => {
          if (discard === "cancel") { discardedView.current = true; leaveEditor(); }
          else if (discard) changeSource(discard);
        }}>Discard changes</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {pending ? <p role="status" className="sr-only">{pending === "history" ? "Loading revision history…" : pending === "delete" ? `Deleting ${selected?.latest.content.name ?? "skill"} and its revision history…` : pending === "latest" ? "Reloading the current skill version…" : pending === "save" ? "Saving your draft…" : pending === "disable" ? "Turning off this skill for your chats…" : `Making revision ${selected?.latest.revision ?? ""} available for your chats…`}</p> : null}
    </> : null}
  </section>;
}
