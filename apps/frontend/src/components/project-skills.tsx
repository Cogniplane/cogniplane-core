"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PersonalSkill, ProjectSkill, ProjectSkillRevision, ProjectSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { getPersonalSkill, getPersonalSkills } from "@/lib/personal-skills-api";
import {
  actOnProjectSkill, copyPersonalSkillToProject, createProjectSkill, deleteProjectSkill,
  getProjectSkillHistory, getProjectSkills, updateProjectSkill, updateProjectSkillFromPersonal
} from "@/lib/project-skills-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { emptySkillContent, readSkillMarkdownFile, skillEditorComplete, skillEditorSource,
  SkillConflictChoice, SkillHistory, SkillInstructions, SkillNotice, SkillSourceFields, SkillValidation, skillFocusRing, type SkillEditorState } from "./skill-editor-parts";

const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";
const status = (skill: ProjectSkill) => skill.enabled && skill.active ? "Released in this project" : skill.active ? "Off" : "Draft";
type Operation = "save" | "release" | "disable" | "delete" | "copy-list" | "copy-read" | "copy" | "source-read" | "source-update" | "history" | "load";
type Props = {
  scope: ProjectSkillScope; projectName: string; archived: boolean; canManage: boolean;
  onChanged?: () => void; onAccessFailure?: () => Promise<unknown>;
};
type Mode = "list" | "create" | "edit" | "details" | "copy";

export function ProjectSkills(props: Props) {
  // Changing account or project discards the previous scope's draft and requests.
  return <ProjectSkillsView key={JSON.stringify([props.scope.tenantId, props.scope.userId, props.scope.projectId])} {...props} />;
}

function ProjectSkillsView({ scope, projectName, archived, canManage, onChanged, onAccessFailure }: Props) {
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState>({ kind: "inline", content: { ...emptySkillContent } });
  const [baseline, setBaseline] = useState("");
  const [personal, setPersonal] = useState<PersonalSkill[]>([]);
  const [copyCandidate, setCopyCandidate] = useState<PersonalSkill | null>(null);
  const [sourceCandidate, setSourceCandidate] = useState<PersonalSkill | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [history, setHistory] = useState<ProjectSkillRevision[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Set after a save conflict. Save stays blocked until the user keeps their text or takes the latest version.
  const [conflictSkillId, setConflictSkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Operation | null>(null);
  const busy = pending !== null;
  const requestPending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const lockedRef = useRef(false);
  const fileRead = useRef(0);
  const filePending = useRef(false);
  const readNumber = useRef(0);
  const recovery = useRef<{ id: string; editing: boolean } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [errorAt, setErrorAt] = useState<Operation>("load");
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [expired, setExpired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef(false);
  const previousAccess = useRef({ canManage, archived });
  const selected = skills.find((skill) => skill.id === selectedId) ?? null;
  const editable = canEdit && canManage && !archived && !locked;
  const disabled = !editable || busy || loading || readingFile || readFailed;
  const actionDisabled = (operation: Operation, extra = false) => extra || !editable || loading || readingFile || readFailed || (busy && pending !== operation);
  const dirty = (mode === "create" || mode === "edit") && JSON.stringify(editor) !== baseline;
  const conflict = mode === "edit" && selected && conflictSkillId === selected.id ? selected : null;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; fileRead.current += 1; };
  }, []);
  useLayoutEffect(() => { if (pendingFocus.current) { pendingFocus.current = false; heading.current?.focus(); } }, [mode, selectedId, skills]);
  const lock = useCallback((sessionExpired = false) => {
    pendingFocus.current = heading.current?.closest("section")?.contains(document.activeElement) ?? false;
    lockedRef.current = true; generation.current += 1; fileRead.current += 1;
    filePending.current = false; requestPending.current = false;
    setEditor({ kind: "inline", content: { ...emptySkillContent } }); setBaseline("");
    setConflictSkillId(null); setConfirmDelete(false); setError(null); setFileError(null); setNotice(null);
    recovery.current = null; setReadFailed(false); setReadingFile(false); setPending(null); setLoading(false);
    setLocked(true); setExpired(sessionExpired); setSkills([]); setPersonal([]); setCopyCandidate(null);
    setSourceCandidate(null); setSelectedId(null); setMode("list"); setReviewed(null); setHistory(null);
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
    setError(message(cause));
    if (cause instanceof ApiError && (cause.status === 403 || cause.code === "project_archived")) {
      setCanEdit(false); void onAccessFailure?.();
    }
  }, [lock, onAccessFailure]);
  const reconcile = useCallback((latest: ProjectSkill[]) => {
    const target = recovery.current;
    if (!target) return;
    recovery.current = null;
    if (!latest.some(skill => skill.id === target.id)) {
      setSelectedId(null); setHistory(null); setReviewed(null); setSourceCandidate(null);
      setConfirmDelete(false); setConflictSkillId(null); setMode(target.editing ? "create" : "list");
      setNotice(target.editing
        ? "This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel."
        : "This skill was deleted elsewhere. It is no longer in this project.");
      setError(null);
    } else {
      if (target.editing) setConflictSkillId(target.id);
      setError(`Project skills were reloaded. Review the current revision before trying again.${target.editing ? " Your unsaved text is still here." : ""}`);
    }
  }, []);
  const reload = useCallback(async () => {
    if (lockedRef.current) return null;
    const number = ++readNumber.current, epoch = generation.current;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current && number === readNumber.current;
    setLoading(true);
    try {
      const result = await getProjectSkills(scope.projectId);
      if (!current() || !check(result.scope)) return null;
      setSkills(result.skills); setCanEdit(result.canEdit); setHistory(null); setReviewed(null); setSourceCandidate(null);
      setReadFailed(false); setError(null); reconcile(result.skills);
      return result.skills;
    } catch (cause) {
      if (current()) { setReadFailed(true); fail(cause); }
      return null;
    } finally { if (current()) setLoading(false); }
  }, [scope.projectId, check, fail, reconcile]);
  useEffect(() => {
    let active = true;
    const epoch = generation.current, number = ++readNumber.current;
    const current = () => active && mounted.current && !lockedRef.current && epoch === generation.current && number === readNumber.current;
    getProjectSkills(scope.projectId).then(result => {
      if (!current() || !check(result.scope)) return;
      setSkills(result.skills); setCanEdit(result.canEdit); setReadFailed(false);
    }).catch((cause: unknown) => { if (current()) { setReadFailed(true); fail(cause); } })
      .finally(() => { if (current()) setLoading(false); });
    return () => { active = false; };
  }, [scope.projectId, check, fail]);
  useLayoutEffect(() => {
    const previous = previousAccess.current;
    previousAccess.current = { canManage, archived };
    if ((previous.canManage !== canManage || previous.archived !== archived) && !lockedRef.current) {
      generation.current += 1; fileRead.current += 1; filePending.current = false;
      requestPending.current = false; setPending(null); setReadingFile(false); setReviewed(null);
      void reload();
    }
  }, [canManage, archived, reload]);
  const replace = (skill: ProjectSkill) => {
    setSkills((items) => [...items.filter((item) => item.id !== skill.id), skill]
      .sort((a, b) => a.latest.content.name.localeCompare(b.latest.content.name)));
    setSelectedId(skill.id); setHistory(null); setReviewed(null); setSourceCandidate(null);
  };
  const beginCreate = () => {
    const next: SkillEditorState = { kind: "inline", content: { ...emptySkillContent } };
    setEditor(next); setBaseline(JSON.stringify(next)); setMode("create"); setSelectedId(null);
    setError(null); setNotice(null); setFileError(null); setReviewed(null); setHistory(null); setSourceCandidate(null); setConfirmDelete(false); pendingFocus.current = true;
  };
  const beginEdit = (skill: ProjectSkill) => {
    if (readFailed || recovery.current) return;
    const next: SkillEditorState = { kind: "inline", content: { ...skill.latest.content } };
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(skill.id); setMode("edit");
    setError(null); setNotice(null); setFileError(null); setReviewed(null); setHistory(null); setSourceCandidate(null); setConfirmDelete(false); setConflictSkillId(null); pendingFocus.current = true;
  };
  const run = async (operation: Operation, work: (current: () => boolean, trigger: Element | null) => Promise<void>, readOnly = false) => {
    if (requestPending.current || loading || lockedRef.current || filePending.current || (!readOnly && (!editable || readFailed))) return;
    requestPending.current = true;
    const epoch = generation.current, trigger = document.activeElement;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current;
    setPending(operation); setErrorAt(operation); setError(null); setNotice(null);
    try { await work(current, trigger); }
    catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && (cause.code === "project_skill_conflict" || cause.status === 404)) {
        setReviewed(null); setCopyCandidate(null); setSourceCandidate(null); setConfirmDelete(false);
        if (selectedId) recovery.current = { id: selectedId, editing: mode === "edit" };
        setReadFailed(true);
        await reload();
        if (current() && !selectedId) setError(`${message(cause)} Review the source again before trying to copy.`);
      } else fail(cause);
    } finally {
      if (current()) { requestPending.current = false; setPending(null); }
    }
  };
  const save = () => {
    if (conflict || !skillEditorComplete(editor) || (mode === "edit" && !dirty)) return;
    void run("save", async (current, trigger) => {
      const result = mode === "create"
      ? await createProjectSkill(scope.projectId, { scope, source: skillEditorSource(editor) })
      : selected && await updateProjectSkill(scope.projectId, selected.id, { scope, source: skillEditorSource(editor), version: selected.version });
      if (!result || !current() || !check(result.scope)) return;
      replace(result.skill); setBaseline(JSON.stringify(editor)); setMode("details");
      setNotice(`Draft revision ${result.skill.latest.revision} saved. Release is a separate action.`);
      pendingFocus.current = document.activeElement === trigger;
    });
  };
  const act = (action: "release" | "disable") => {
    if (!selected || (action === "release" && reviewed !== `release:${selected.id}:${selected.latest.revision}:${selected.version}`)) return;
    void run(action, async (current) => {
      const result = await actOnProjectSkill(scope.projectId, selected.id, { scope, version: selected.version, action });
      if (!current() || !check(result.scope)) return;
      replace(result.skill); setConfirmDelete(false); setNotice(action === "release" ? `Revision ${result.skill.active?.revision} released in ${projectName}. It applies on the next turn when selected.` : "This project skill is off for future turns."); onChanged?.();
    });
  };
  const remove = () => {
    if (!selected || !confirmDelete) return;
    void run("delete", async (current, trigger) => {
      const result = await deleteProjectSkill(scope.projectId, selected.id, { scope, version: selected.version });
      if (!current() || !check(result.scope)) return;
      setSkills((items) => items.filter((item) => item.id !== selected.id));
      setSelectedId(null); setMode("list"); setConfirmDelete(false); onChanged?.(); pendingFocus.current = document.activeElement === trigger;
    });
  };
  const openCopy = () => void run("copy-list", async (current, trigger) => {
    const result = await getPersonalSkills();
    if (!current()) return;
    if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
    setPersonal(result.skills.filter((skill) => skill.enabled && skill.active));
    setCopyCandidate(null); setMode("copy"); setError(null); pendingFocus.current = document.activeElement === trigger;
  });
  const chooseCopy = (id: string) => void run("copy-read", async (current) => {
    setCopyCandidate(null); setReviewed(null);
    const result = await getPersonalSkill(id);
    if (!current()) return;
    if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
    if (!result.skill.enabled || !result.skill.active) { setError("This private skill is no longer released. Reload the private library."); return; }
    setCopyCandidate(result.skill); setReviewed(null);
  });
  const copy = () => {
    if (!copyCandidate?.active || reviewed !== `copy:${copyCandidate.id}:${copyCandidate.active.revision}`) return;
    void run("copy", async (current, trigger) => {
      const result = await copyPersonalSkillToProject(scope.projectId, { scope, personalSkillId: copyCandidate.id, sourceRevision: copyCandidate.active!.revision });
      if (!current() || !check(result.scope)) return;
      replace(result.skill); setCopyCandidate(null); setMode("details"); setNotice("Private revision copied into a separate project draft. Review it before release."); pendingFocus.current = document.activeElement === trigger;
    });
  };
  const inspectSource = () => {
    if (!selected?.copiedFrom?.mine || !selected.copiedFrom.personalSkillId) return;
    void run("source-read", async (current) => {
      setSourceCandidate(null); setReviewed(null);
      const result = await getPersonalSkill(selected.copiedFrom!.personalSkillId!);
      if (!current()) return;
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
      if (!result.skill.enabled || !result.skill.active) { setError("Your private source is no longer released."); return; }
      setSourceCandidate(result.skill); setReviewed(null);
    }, true);
  };
  const updateSource = () => {
    if (!selected || !sourceCandidate?.active || reviewed !== `update:${selected.id}:${sourceCandidate.active.revision}:${selected.version}`) return;
    void run("source-update", async (current) => {
      const result = await updateProjectSkillFromPersonal(scope.projectId, selected.id, {
        scope, version: selected.version, sourceRevision: sourceCandidate.active!.revision
      });
      if (!current() || !check(result.scope)) return;
      replace(result.skill); setNotice(`Private revision ${sourceCandidate.active!.revision} copied into draft revision ${result.skill.latest.revision}. Release is a separate action.`);
    });
  };
  const showHistory = () => {
    if (!selected) return;
    void run("history", async (current) => {
      const result = await getProjectSkillHistory(scope.projectId, selected.id);
      if (current() && check(result.scope)) setHistory(result.revisions);
    }, true);
  };
  const cancel = () => {
    if (dirty && !window.confirm("Discard your unsaved skill changes?")) return;
    if (recovery.current) recovery.current.editing = false;
    setMode(selectedId ? "details" : "list"); setError(null); setConflictSkillId(null); pendingFocus.current = true;
  };
  const readFile = async (file?: File) => {
    if (!file || filePending.current || requestPending.current || !editable || readFailed) return;
    const number = ++fileRead.current, epoch = generation.current;
    const current = () => mounted.current && !lockedRef.current && epoch === generation.current && number === fileRead.current;
    filePending.current = true; setReadingFile(true); setFileError(null);
    try { const markdown = await readSkillMarkdownFile(file); if (current()) setEditor({ kind: "markdown", markdown }); }
    catch (cause) { if (current()) setFileError(message(cause)); }
    finally { if (current()) { filePending.current = false; setReadingFile(false); } }
  };
  const feedback = (operation: Operation) => error && !readFailed && errorAt === operation
    ? <SkillNotice role="alert" tone={conflict ? "attention" : "danger"} title={conflict ? "Review the latest revision" : "Request did not complete"}><p>{error}</p>{operation === "save" ? <p>Your draft text is kept. Save again after you review any newer revision and the service is available.</p> : null}</SkillNotice> : null;
  const label = (operation: Operation, idle: string, active: string) => pending === operation ? active : idle;
  const closeHistory = () => { setHistory(null); setError(null); historyButton.current?.focus(); };
  const back = () => {
    setMode("list"); setSelectedId(null); setHistory(null); setReviewed(null); setSourceCandidate(null);
    setCopyCandidate(null); setConfirmDelete(false); setError(null); setNotice(null); pendingFocus.current = true;
  };
  const viewHeading = `min-w-0 break-words rounded-sm text-lg font-semibold ${skillFocusRing}`;
  const checkbox = `mt-1 size-4 shrink-0 accent-primary ${skillFocusRing}`;
  const newDraft = selected?.latest.revision !== selected?.active?.revision;
  return <section aria-labelledby="project-skills-title" className="min-w-0 space-y-5 border-t border-outline-variant py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-[64ch]">
        <h3 id="project-skills-title" ref={mode === "list" ? heading : undefined} tabIndex={-1} className={`rounded-sm font-semibold ${skillFocusRing}`}>Project skills</h3>
        <p className="mt-1 text-sm text-on-surface-variant">Write and review skills shared with members of {projectName}. Saving keeps a draft. Release makes that revision available for selected project chats on their next turn.</p>
      </div>
      {mode === "list" && editable ? <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={beginCreate}>Create project skill</Button>
        <Button size="sm" variant="outline" disabled={actionDisabled("copy-list")} aria-disabled={pending === "copy-list"} onClick={openCopy}>{label("copy-list", "Copy from my private skills", "Loading private skills…")}</Button>
      </div> : null}
    </div>
    {locked ? <SkillNotice role="alert" tone="danger" title={expired ? "Your session expired." : "Your account, organization, or project changed."}>
      <p>Reload this page before editing project skills. Draft text has been cleared.</p><Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
    </SkillNotice> : null}
    {!locked && readFailed ? <SkillNotice role="alert" tone="attention" title="Latest project skills could not be loaded">
      <p>{error} Editing and release are blocked until the latest revisions load.{mode === "edit" || mode === "create" ? " Your unsaved text is still here." : ""}</p>
      <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { if (!recovery.current) setErrorAt("load"); void reload(); }}>{loading ? "Reloading skills…" : "Reload skills"}</Button>
    </SkillNotice> : null}
    {!locked && (errorAt === "load" || !editable) ? feedback(errorAt) : null}
    {!locked && notice ? <SkillNotice role="status" className="break-words" tone={notice.startsWith("This skill was deleted") ? "attention" : "success"} title={notice} /> : null}
    {loading && !locked ? <div role="status" aria-label="Loading project skills"><span className="text-sm text-on-surface-variant">Loading project skills…</span>{skills.length === 0 ? <Skeleton className="mt-2 h-14" /> : null}</div> : null}
    {!locked && !loading && !editable ? <p className="max-w-[64ch] text-sm text-on-surface-variant">{archived ? "Restore this project to change its skills." : "Project skills are read-only. Only an owner can change them when project work allows edits."}</p> : null}
    {mode === "list" && !locked && !loading ? <>
      {feedback("copy-list")}
      {skills.length ? <ul className="divide-y divide-outline-variant">{skills.map(skill => <li key={skill.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
        <div className="min-w-0 flex-1 basis-56"><p className="break-words font-medium">{skill.latest.content.name}</p><p className="mt-1 max-w-[64ch] whitespace-pre-wrap break-words text-sm text-on-surface-variant">{skill.latest.content.description}</p>
          <p className="mt-2 text-xs text-on-surface-variant">{status(skill)}{skill.active ? ` · Released revision ${skill.active.revision}${skill.enabled ? "" : ", off"}` : " · Nothing released"}{skill.active?.revision !== skill.latest.revision ? ` · Draft revision ${skill.latest.revision}` : ""}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSelectedId(skill.id); setMode("details"); setError(null); setNotice(null); setHistory(null); setReviewed(null); setConfirmDelete(false); setSourceCandidate(null); pendingFocus.current = true; }}>Details</Button>
      </li>)}</ul> : <p className="text-sm text-on-surface-variant">No project skills yet. An owner can create a draft or copy a released private skill.</p>}
    </> : null}
    {(mode === "create" || mode === "edit") && !locked ? <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><h4 ref={heading} tabIndex={-1} className={viewHeading}>{mode === "create" ? `Create a draft in ${projectName}` : `Edit ${selected?.latest.content.name}`}</h4><Button size="sm" variant="ghost" disabled={busy || readingFile} onClick={cancel}>Cancel</Button></div>
      {mode === "edit" && selected ? <p className="text-sm text-on-surface-variant">Editing draft revision {selected.latest.revision}.{selected.active ? ` Released revision ${selected.active.revision} stays ${selected.enabled ? "available" : "off"} until you release a change.` : " No revision is released yet."}</p> : null}
      <SkillSourceFields idPrefix="project-skill" editor={editor} disabled={disabled} onChange={setEditor} onSwitch={kind => {
        if (kind === editor.kind) return;
        if (dirty && !window.confirm("Discard the text you entered?")) return;
        const next: SkillEditorState = kind === "inline" ? { kind, content: { ...emptySkillContent } } : { kind, markdown: "" };
        setEditor(next); setBaseline(JSON.stringify(next)); setFileError(null);
      }} onFile={file => void readFile(file)} fileMessage={fileError ? <p role="alert" className="text-sm text-danger">{fileError}</p> : readingFile ? <p role="status" className="text-sm">Reading SKILL.md…</p> : null} />
      {conflict ? <SkillConflictChoice content={conflict.latest.content} disabled={disabled} onKeep={() => { setConflictSkillId(null); setError(null); }} onUseLatest={() => beginEdit(conflict)} /> : null}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3"><Button size="sm" disabled={actionDisabled("save", Boolean(conflict) || !skillEditorComplete(editor) || (mode === "edit" && !dirty))} aria-disabled={pending === "save"} onClick={save}>{label("save", "Save draft", "Saving draft…")}</Button><p className="max-w-[64ch] text-xs text-on-surface-variant">Saving does not release this draft or change the released revision.</p></div>
        {feedback("save")}
      </div>
    </div> : null}
    {mode === "copy" && !locked ? <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2"><h4 ref={heading} tabIndex={-1} className={viewHeading}>Copy a private skill into {projectName}</h4><Button size="sm" variant="ghost" disabled={busy} onClick={back}>Back to skills</Button></div>
      <p className="max-w-[64ch] text-sm text-on-surface-variant">A copy becomes a separate project draft. Later private edits do not change it.</p>
      {personal.length ? <ul className="flex flex-wrap gap-2">{personal.map(skill => <li key={skill.id} className="min-w-0"><Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal break-words text-left" disabled={actionDisabled("copy-read")} aria-disabled={pending === "copy-read"} onClick={() => chooseCopy(skill.id)}>{skill.active?.content.name}</Button></li>)}</ul> : <p className="text-sm">You have no released private skills to copy.</p>}
      {pending === "copy-read" ? <p role="status" className="text-sm">Loading released private revision…</p> : null}{feedback("copy-read")}{feedback("copy")}
      {copyCandidate?.active ? <div className="space-y-4 border-t border-outline-variant pt-4">
        <p className="break-words font-medium">{copyCandidate.active.content.name} · private revision {copyCandidate.active.revision}</p><p className="max-w-[64ch] whitespace-pre-wrap break-words text-sm text-on-surface-variant">{copyCandidate.active.content.description}</p>
        <SkillInstructions title="Released private instructions to review" text={copyCandidate.active.content.instructions} /><SkillValidation messages={copyCandidate.active.validationMessages} />
        <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed === `copy:${copyCandidate.id}:${copyCandidate.active.revision}`} onChange={event => setReviewed(event.target.checked ? `copy:${copyCandidate.id}:${copyCandidate.active!.revision}` : null)} />I reviewed this released revision {copyCandidate.active.revision} before copying it into {projectName}.</label>
        <Button size="sm" disabled={actionDisabled("copy", reviewed !== `copy:${copyCandidate.id}:${copyCandidate.active.revision}`)} aria-disabled={pending === "copy"} onClick={copy}>{label("copy", "Create project draft", "Copying revision…")}</Button>
      </div> : null}
    </div> : null}
    {mode === "details" && selected && !locked ? <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1 basis-56"><h4 ref={heading} tabIndex={-1} className={viewHeading}>{selected.latest.content.name}</h4><p className="mt-1 max-w-[64ch] whitespace-pre-wrap break-words text-sm text-on-surface-variant">{selected.latest.content.description}</p></div><Button size="sm" variant="ghost" disabled={busy} onClick={back}>Back to skills</Button></div>
      <dl className="grid gap-4 rounded-md bg-surface-container-low p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-on-surface-variant">Released in this project</dt><dd className="mt-1 font-semibold">{selected.active ? `Revision ${selected.active.revision}${selected.enabled ? ", available" : ", off"}` : "Nothing released"}</dd></div>
        <div><dt className="text-on-surface-variant">Showing below</dt><dd className="mt-1 font-semibold">{newDraft ? `Draft revision ${selected.latest.revision}, not released` : `Revision ${selected.latest.revision}, ${selected.enabled ? "released" : "off"}`}</dd></div>
      </dl>
      {selected.copiedFrom ? <p className="max-w-[64ch] text-xs text-on-surface-variant">Copied from {selected.copiedFrom.mine ? "your" : "a member's"} private skill, source revision {selected.copiedFrom.revision}. Project edits and source updates are separate.</p> : null}
      {selected.active && newDraft ? <details><summary className={`cursor-pointer rounded-sm text-sm font-medium ${skillFocusRing}`}>Inspect released revision {selected.active.revision}{selected.enabled ? "" : ", off"}</summary><div className="mt-3 space-y-2"><p className="break-words text-sm font-medium">{selected.active.content.name}</p><p className="max-w-[64ch] whitespace-pre-wrap break-words text-sm">{selected.active.content.description}</p><SkillInstructions title={`Released revision ${selected.active.revision} instructions`} text={selected.active.content.instructions} /></div></details> : null}
      <SkillInstructions title={newDraft ? `Draft revision ${selected.latest.revision} instructions` : `Revision ${selected.latest.revision} instructions`} text={selected.latest.content.instructions} /><SkillValidation messages={selected.latest.validationMessages} />
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {editable ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => beginEdit(selected)}>Edit draft</Button> : null}
          <Button ref={historyButton} size="sm" variant="outline" disabled={loading || (busy && pending !== "history")} aria-disabled={pending === "history"} aria-expanded={history !== null} aria-controls="project-skill-history" onClick={() => history ? closeHistory() : showHistory()}>{label("history", "History", "Loading history…")}</Button>
          {editable && selected.enabled ? <Button size="sm" variant="outline" disabled={actionDisabled("disable")} aria-disabled={pending === "disable"} onClick={() => act("disable")}>{label("disable", "Turn off", "Turning off…")}</Button> : null}
          {editable ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
        </div>
        {feedback("disable")}{feedback("history")}{!confirmDelete ? feedback("delete") : null}
        {history ? <div className="space-y-3" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeHistory(); } }}><div className="flex justify-end"><Button size="sm" variant="ghost" onClick={closeHistory}>Close history</Button></div><SkillHistory id="project-skill-history" revisions={history} markers={revision => [revision.revision === selected.latest.revision ? "Latest saved" : "", revision.revision === selected.active?.revision ? selected.enabled ? "Released" : "Off" : ""].filter(Boolean)} note={revision => revision.copiedFromRevision ? `Copied from private revision ${revision.copiedFromRevision}` : null} /></div> : null}
      </div>
      {editable && (!selected.enabled || newDraft) ? <div className="space-y-3 rounded-md bg-surface-container-low p-4">
        <h5 className="text-sm font-semibold">{newDraft ? `Review draft revision ${selected.latest.revision} for release` : `Release revision ${selected.latest.revision} again`}</h5>
        <p className="max-w-[64ch] text-sm text-on-surface-variant">{selected.active && newDraft ? `Release replaces revision ${selected.active.revision} with revision ${selected.latest.revision}.` : `Release makes revision ${selected.latest.revision} available.`} The change applies on the next turn when the skill is selected.</p>
        <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed === `release:${selected.id}:${selected.latest.revision}:${selected.version}`} onChange={event => setReviewed(event.target.checked ? `release:${selected.id}:${selected.latest.revision}:${selected.version}` : null)} />I reviewed this draft revision {selected.latest.revision} and its validation messages.</label>
        <Button size="sm" disabled={actionDisabled("release", reviewed !== `release:${selected.id}:${selected.latest.revision}:${selected.version}`)} aria-disabled={pending === "release"} onClick={() => act("release")}>{label("release", `Release in ${projectName}`, `Releasing revision ${selected.latest.revision}…`)}</Button>
        <p className="max-w-[64ch] text-xs text-on-surface-variant">Release adds this skill to a custom project selection. Chats with saved selections need you to add it there too.</p>{feedback("release")}
      </div> : null}
      {editable && selected.copiedFrom?.mine && selected.copiedFrom.personalSkillId ? <div className="space-y-3 border-t border-outline-variant pt-4">
        <Button size="sm" variant="outline" disabled={actionDisabled("source-read")} aria-disabled={pending === "source-read"} onClick={inspectSource}>{label("source-read", "Check my private source", "Loading private source…")}</Button>{feedback("source-read")}{feedback("source-update")}
        {sourceCandidate?.active ? <div className="space-y-3"><p className="text-sm font-medium">Released private revision {sourceCandidate.active.revision}. Updating creates a project draft.</p><SkillInstructions title="Private source instructions" text={sourceCandidate.active.content.instructions} /><SkillValidation messages={sourceCandidate.active.validationMessages} />
          <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed === `update:${selected.id}:${sourceCandidate.active.revision}:${selected.version}`} onChange={event => setReviewed(event.target.checked ? `update:${selected.id}:${sourceCandidate.active!.revision}:${selected.version}` : null)} />I reviewed this private revision {sourceCandidate.active.revision} for project draft {selected.latest.revision}.</label>
          <Button size="sm" className="h-auto min-h-8 whitespace-normal text-left" disabled={actionDisabled("source-update", reviewed !== `update:${selected.id}:${sourceCandidate.active.revision}:${selected.version}`)} aria-disabled={pending === "source-update"} onClick={updateSource}>{label("source-update", "Create draft from private source", "Updating project draft…")}</Button>
        </div> : null}
      </div> : null}
      {confirmDelete && editable ? <SkillNotice role="group" aria-label="Confirm deletion" className="break-words" tone="attention" title={`Delete ${selected.latest.content.name}?`}><p>Delete this project skill and its history?</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="destructive" disabled={actionDisabled("delete")} aria-disabled={pending === "delete"} onClick={remove}>{label("delete", "Delete skill", "Deleting skill…")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep skill</Button></div>{feedback("delete")}</SkillNotice> : null}
    </div> : null}
  </section>;
}
