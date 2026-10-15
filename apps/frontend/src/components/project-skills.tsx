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
  SkillConflictChoice, SkillHistory, SkillInstructions, SkillSourceFields, SkillValidation, type SkillEditorState } from "./skill-editor-parts";

const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";
const status = (skill: ProjectSkill) => skill.enabled && skill.active ? "Released in this project" : skill.active ? "Off" : "Draft";
type Mode = "list" | "create" | "edit" | "details" | "copy";

export function ProjectSkills({ scope, projectName, archived, canManage, onChanged, onAccessFailure }: {
  scope: ProjectSkillScope; projectName: string; archived: boolean; canManage: boolean;
  onChanged?: () => void; onAccessFailure?: () => Promise<unknown>;
}) {
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
  const [busy, setBusy] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [expired, setExpired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef(false);
  const previousAccess = useRef({ canManage, archived });
  const selected = skills.find((skill) => skill.id === selectedId) ?? null;
  const editable = canEdit && canManage && !archived && !locked;
  const disabled = !editable || busy || loading || readingFile;
  const dirty = (mode === "create" || mode === "edit") && JSON.stringify(editor) !== baseline;
  const conflict = mode === "edit" && selected && conflictSkillId === selected.id ? selected : null;
  useLayoutEffect(() => { if (pendingFocus.current) { pendingFocus.current = false; heading.current?.focus(); } }, [mode, selectedId]);
  const lock = useCallback((sessionExpired = false) => {
    setLocked(true); setExpired(sessionExpired); setSkills([]); setPersonal([]); setCopyCandidate(null);
    setSourceCandidate(null); setSelectedId(null); setMode("list"); setReviewed(null); setHistory(null);
  }, []);
  const check = useCallback((actual: ProjectSkillScope) => {
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
  const reload = useCallback(async () => {
    if (locked) return null;
    setLoading(true);
    try {
      const result = await getProjectSkills(scope.projectId);
      if (!check(result.scope)) return null;
      setSkills(result.skills); setCanEdit(result.canEdit); setHistory(null); setReviewed(null);
      return result.skills;
    } catch (cause) { fail(cause); return null; }
    finally { setLoading(false); }
  }, [scope.projectId, check, fail, locked]);
  useEffect(() => {
    let active = true;
    getProjectSkills(scope.projectId).then((result) => {
      if (!active || !check(result.scope)) return;
      setSkills(result.skills); setCanEdit(result.canEdit);
    }).catch((cause: unknown) => { if (active) fail(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope.projectId, check, fail]);
  useEffect(() => {
    const previous = previousAccess.current;
    previousAccess.current = { canManage, archived };
    if ((previous.canManage !== canManage || previous.archived !== archived) && !locked) void reload();
  }, [canManage, archived, locked, reload]);
  const replace = (skill: ProjectSkill) => {
    setSkills((items) => [...items.filter((item) => item.id !== skill.id), skill]
      .sort((a, b) => a.latest.content.name.localeCompare(b.latest.content.name)));
    setSelectedId(skill.id); setHistory(null); setReviewed(null); setSourceCandidate(null);
  };
  const beginCreate = () => {
    const next: SkillEditorState = { kind: "inline", content: { ...emptySkillContent } };
    setEditor(next); setBaseline(JSON.stringify(next)); setMode("create"); setSelectedId(null);
    setError(null); setReviewed(null); pendingFocus.current = true;
  };
  const beginEdit = (skill: ProjectSkill) => {
    const next: SkillEditorState = { kind: "inline", content: { ...skill.latest.content } };
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(skill.id); setMode("edit");
    setError(null); setReviewed(null); setConflictSkillId(null); pendingFocus.current = true;
  };
  const run = async (work: () => Promise<void>, readOnly = false) => {
    if (busy || loading || locked || readingFile || (!readOnly && !editable)) return;
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) {
      if (cause instanceof ApiError && (cause.code === "project_skill_conflict" || cause.status === 404)) {
        const latest = await reload();
        if (latest) {
          if (selectedId && !latest.some((skill) => skill.id === selectedId)) {
            setSelectedId(null); setHistory(null); setReviewed(null); setSourceCandidate(null);
            setConfirmDelete(false); setMode(mode === "edit" ? "create" : "list"); pendingFocus.current = true;
            setError(mode === "edit"
              ? "This skill was deleted elsewhere. Your text is still here. Save it as a new project draft or cancel."
              : "This skill was deleted elsewhere. It is no longer in this project.");
          } else {
            if (mode === "edit" && cause instanceof ApiError && cause.code === "project_skill_conflict") setConflictSkillId(selectedId);
            setError(`${message(cause)} Project skills were reloaded. Review the current revision before trying again.${dirty ? " Your unsaved text is still here." : ""}`);
          }
        }
      } else fail(cause);
    } finally { setBusy(false); }
  };
  const save = () => void run(async () => {
    const result = mode === "create"
      ? await createProjectSkill(scope.projectId, { scope, source: skillEditorSource(editor) })
      : selected && await updateProjectSkill(scope.projectId, selected.id, { scope, source: skillEditorSource(editor), version: selected.version });
    if (!result || !check(result.scope)) return;
    replace(result.skill); setBaseline(JSON.stringify(editor)); setMode("details"); pendingFocus.current = true;
  });
  const act = (action: "release" | "disable") => {
    if (!selected) return;
    void run(async () => {
      const result = await actOnProjectSkill(scope.projectId, selected.id, { scope, version: selected.version, action });
      if (!check(result.scope)) return;
      replace(result.skill); setConfirmDelete(false); onChanged?.();
    });
  };
  const remove = () => {
    if (!selected || !confirmDelete) return;
    void run(async () => {
      const result = await deleteProjectSkill(scope.projectId, selected.id, { scope, version: selected.version });
      if (!check(result.scope)) return;
      setSkills((items) => items.filter((item) => item.id !== selected.id));
      setSelectedId(null); setMode("list"); setConfirmDelete(false); onChanged?.(); pendingFocus.current = true;
    });
  };
  const openCopy = () => void run(async () => {
    const result = await getPersonalSkills();
    if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
    setPersonal(result.skills.filter((skill) => skill.enabled && skill.active));
    setCopyCandidate(null); setMode("copy"); setError(null); pendingFocus.current = true;
  });
  const chooseCopy = (id: string) => void run(async () => {
    const result = await getPersonalSkill(id);
    if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
    if (!result.skill.enabled || !result.skill.active) { setError("This private skill is no longer released. Reload the private library."); return; }
    setCopyCandidate(result.skill); setReviewed(null);
  });
  const copy = () => {
    if (!copyCandidate?.active) return;
    void run(async () => {
      const result = await copyPersonalSkillToProject(scope.projectId, { scope, personalSkillId: copyCandidate.id, sourceRevision: copyCandidate.active!.revision });
      if (!check(result.scope)) return;
      replace(result.skill); setCopyCandidate(null); setMode("details"); pendingFocus.current = true;
    });
  };
  const inspectSource = () => {
    if (!selected?.copiedFrom?.mine || !selected.copiedFrom.personalSkillId) return;
    void run(async () => {
      const result = await getPersonalSkill(selected.copiedFrom!.personalSkillId!);
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
      if (!result.skill.enabled || !result.skill.active) { setError("Your private source is no longer released."); return; }
      setSourceCandidate(result.skill); setReviewed(null);
    }, true);
  };
  const updateSource = () => {
    if (!selected || !sourceCandidate?.active) return;
    void run(async () => {
      const result = await updateProjectSkillFromPersonal(scope.projectId, selected.id, {
        scope, version: selected.version, sourceRevision: sourceCandidate.active!.revision
      });
      if (!check(result.scope)) return;
      replace(result.skill);
    });
  };
  const showHistory = () => {
    if (!selected) return;
    void run(async () => {
      const result = await getProjectSkillHistory(scope.projectId, selected.id);
      if (check(result.scope)) setHistory(result.revisions);
    }, true);
  };
  const cancel = () => {
    if (dirty && !window.confirm("Discard your unsaved skill changes?")) return;
    setMode(selectedId ? "details" : "list"); setError(null); setConflictSkillId(null); pendingFocus.current = true;
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    setReadingFile(true);
    try { setEditor({ kind: "markdown", markdown: await readSkillMarkdownFile(file) }); setError(null); }
    catch (cause) { setError(message(cause)); }
    finally { setReadingFile(false); }
  };
  return <section aria-labelledby="project-skills-title" className="rounded-lg border border-outline-variant bg-surface-container-low p-5 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div>
      <h3 id="project-skills-title" ref={heading} tabIndex={-1} className="font-semibold">Project skills</h3>
      <p className="mt-1 text-sm text-on-surface-variant">Skills in {projectName} are shared with project members. Owners review and release each draft. A released skill follows project defaults, unless a custom selection leaves it out.</p>
    </div>{mode === "list" && editable ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={beginCreate}>Create project skill</Button><Button size="sm" variant="outline" disabled={disabled} onClick={openCopy}>Copy from my private skills</Button></div> : null}</div>
    {locked ? <div role="alert" className="text-sm text-danger"><p>{expired ? "Your session expired." : "Your account, organization, or project changed."} Reload this page before editing project skills.</p><Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button></div> : null}
    {error && !locked ? <div role="alert" className="text-sm text-danger"><p>{error}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>Reload skills</Button></div> : null}
    {loading && skills.length === 0 && !locked ? <div aria-label="Loading project skills"><Skeleton className="h-14" /></div> : null}
    {!locked && !editable ? <p className="text-sm text-on-surface-variant">{archived ? "Restore this project to change its skills." : "Project skills are read-only. Only an owner can change them when project work allows edits."}</p> : null}
    {mode === "list" && !locked && !loading ? skills.length ? <ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">{skills.map((skill) => <li key={skill.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0"><div className="flex flex-wrap gap-2"><span className="font-medium">{skill.latest.content.name}</span><span className="text-xs text-on-surface-variant">{status(skill)}</span>{skill.active && skill.active.revision !== skill.latest.revision ? <span className="text-xs">New draft</span> : null}</div><p className="break-words text-sm text-on-surface-variant">{skill.latest.content.description}</p></div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSelectedId(skill.id); setMode("details"); setError(null); setHistory(null); setReviewed(null); pendingFocus.current = true; }}>Details</Button>
    </li>)}</ul> : <p className="text-sm text-on-surface-variant">No project skills yet.</p> : null}
    {(mode === "create" || mode === "edit") && !locked ? <div className="space-y-4"><div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">{mode === "create" ? `Create a draft in ${projectName}` : `Edit ${selected?.latest.content.name}`}</h4><Button size="sm" variant="ghost" disabled={busy || readingFile} onClick={cancel}>Cancel</Button></div>
      <SkillSourceFields idPrefix="project-skill" editor={editor} disabled={disabled} onChange={setEditor} onSwitch={(kind) => {
        if (kind === editor.kind) return;
        if (dirty && !window.confirm("Discard the text you entered?")) return;
        const next: SkillEditorState = kind === "inline" ? { kind, content: { ...emptySkillContent } } : { kind, markdown: "" };
        setEditor(next); setBaseline(JSON.stringify(next));
      }} onFile={(file) => void readFile(file)} />
      {conflict ? <SkillConflictChoice content={conflict.latest.content} disabled={disabled} onKeep={() => { setConflictSkillId(null); setError(null); }} onUseLatest={() => beginEdit(conflict)} /> : null}
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={disabled || Boolean(conflict) || !skillEditorComplete(editor) || (mode === "edit" && !dirty)} onClick={save}>Save draft</Button><span className="text-xs text-on-surface-variant">The current released revision stays in use until you release this draft.</span></div>
    </div> : null}
    {mode === "copy" && !locked ? <div className="space-y-4"><div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">Copy a private skill into {projectName}</h4><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setMode("list"); setCopyCandidate(null); }}>Back to skills</Button></div>
      <p className="text-sm text-on-surface-variant">A copy becomes a separate project draft. Later private edits do not change it.</p>
      {personal.length ? <ul className="space-y-2">{personal.map((skill) => <li key={skill.id}><Button size="sm" variant="outline" disabled={disabled} onClick={() => chooseCopy(skill.id)}>{skill.active?.content.name}</Button></li>)}</ul> : <p className="text-sm">You have no released private skills to copy.</p>}
      {copyCandidate?.active ? <div className="space-y-3 rounded-md border border-outline-variant p-4"><p className="font-medium">{copyCandidate.active.content.name} · private revision {copyCandidate.active.revision}</p><p className="text-sm">{copyCandidate.active.content.description}</p><SkillInstructions title="Released private instructions to review" text={copyCandidate.active.content.instructions} /><SkillValidation messages={copyCandidate.active.validationMessages} /><label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed === `copy:${copyCandidate.id}:${copyCandidate.active.revision}`} onChange={(event) => setReviewed(event.target.checked ? `copy:${copyCandidate.id}:${copyCandidate.active!.revision}` : null)} />I reviewed this released revision before copying it into {projectName}.</label><Button size="sm" disabled={disabled || reviewed !== `copy:${copyCandidate.id}:${copyCandidate.active.revision}`} onClick={copy}>Create project draft</Button></div> : null}
    </div> : null}
    {mode === "details" && selected && !locked ? <div className="space-y-4"><div className="flex flex-wrap justify-between gap-2"><div><p className="text-xs text-on-surface-variant">{status(selected)} · Active revision {selected.active?.revision ?? "none"} · Draft revision {selected.latest.revision}</p><h4 className="text-lg font-semibold">{selected.latest.content.name}</h4><p className="text-sm text-on-surface-variant">{selected.latest.content.description}</p></div><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setMode("list"); setSelectedId(null); setHistory(null); setReviewed(null); pendingFocus.current = true; }}>Back to skills</Button></div>
      {selected.active && selected.active.revision !== selected.latest.revision ? <p className="text-sm">Project sessions still use revision {selected.active.revision} while this draft waits for release.</p> : null}
      {selected.copiedFrom ? <p className="text-xs text-on-surface-variant">Copied from {selected.copiedFrom.mine ? "your" : "a member's"} private skill, source revision {selected.copiedFrom.revision}. Project edits and source updates are separate.</p> : null}
      <SkillInstructions title="Draft instructions" text={selected.latest.content.instructions} /><SkillValidation messages={selected.latest.validationMessages} />
      {editable ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => beginEdit(selected)}>Edit draft</Button><Button size="sm" variant="outline" disabled={busy || loading} onClick={showHistory}>History</Button>{selected.enabled ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => act("disable")}>Turn off</Button> : null}<Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(true)}>Delete</Button></div> : <Button size="sm" variant="outline" disabled={busy || loading} onClick={showHistory}>History</Button>}
      {editable && (!selected.enabled || selected.active?.revision !== selected.latest.revision) ? <div className="space-y-2 rounded-md border border-outline-variant p-4"><label className="flex gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={reviewed === `release:${selected.id}:${selected.latest.revision}:${selected.version}`} onChange={(event) => setReviewed(event.target.checked ? `release:${selected.id}:${selected.latest.revision}:${selected.version}` : null)} />I reviewed this draft and its validation messages.</label><Button size="sm" disabled={disabled || reviewed !== `release:${selected.id}:${selected.latest.revision}:${selected.version}`} onClick={() => act("release")}>Release in {projectName}</Button><p className="text-xs text-on-surface-variant">Release adds this skill to a custom project selection. Sessions with saved selections need you to add it there too.</p></div> : null}
      {editable && selected.copiedFrom?.mine && selected.copiedFrom.personalSkillId ? <div className="space-y-2"><Button size="sm" variant="outline" disabled={disabled} onClick={inspectSource}>Check my private source</Button>{sourceCandidate?.active ? <div className="space-y-2 rounded-md border border-outline-variant p-4"><p className="text-sm">Released private revision {sourceCandidate.active.revision}. Updating creates a project draft.</p><SkillInstructions title="Private source instructions" text={sourceCandidate.active.content.instructions} /><SkillValidation messages={sourceCandidate.active.validationMessages} /><label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed === `update:${selected.id}:${sourceCandidate.active.revision}:${selected.version}`} onChange={(event) => setReviewed(event.target.checked ? `update:${selected.id}:${sourceCandidate.active!.revision}:${selected.version}` : null)} />I reviewed this private revision.</label><Button size="sm" disabled={disabled || reviewed !== `update:${selected.id}:${sourceCandidate.active.revision}:${selected.version}`} onClick={updateSource}>Create draft from private source</Button></div> : null}</div> : null}
      {confirmDelete && editable ? <div role="group" aria-label="Confirm deletion" className="flex flex-wrap items-center gap-2 rounded-md border border-danger p-3"><span className="text-sm">Delete this project skill and its history?</span><Button size="sm" variant="destructive" disabled={disabled} onClick={remove}>Delete skill</Button><Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Keep skill</Button></div> : null}
      {history ? <SkillHistory revisions={history} note={(revision) => revision.copiedFromRevision ? `Copied from private revision ${revision.copiedFromRevision}` : null} /> : null}
    </div> : null}
  </section>;
}
