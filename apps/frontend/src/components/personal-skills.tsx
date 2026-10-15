"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PersonalSkill, PersonalSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import {
  actOnPersonalSkill, createPersonalSkill, deletePersonalSkill, getPersonalSkillHistory,
  getPersonalSkills, updatePersonalSkill
} from "@/lib/personal-skills-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OrganizationSkillSubmissions } from "./organization-skill-submissions";
import {
  emptySkillContent as emptyContent, readSkillMarkdownFile, skillEditorComplete, skillEditorSource as source,
  SkillConflictChoice, SkillHistory, SkillInstructions, SkillSourceFields, SkillValidation, type SkillEditorState as Editor
} from "./skill-editor-parts";

type Mode = "list" | "create" | "edit" | "review" | "details" | "submissions";
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed. Try again.";
const status = (skill: PersonalSkill) => skill.enabled && skill.active ? "Available only to me" : skill.active ? "Off" : "Draft";

export function PersonalSkills({ expectedScope, requestedSubmissionId = null, onChanged, onDirtyChange }: {
  expectedScope: PersonalSkillScope;
  requestedSubmissionId?: string | null;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [skills, setSkills] = useState<PersonalSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(requestedSubmissionId ? "submissions" : "list");
  const visibleMode = requestedSubmissionId ? "submissions" : mode;
  const [editor, setEditor] = useState<Editor>({ kind: "inline", content: emptyContent });
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeMismatch, setScopeMismatch] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getPersonalSkillHistory>>["revisions"] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Set after a save conflict. Save stays blocked until the user keeps their text or takes the latest version.
  const [conflictSkillId, setConflictSkillId] = useState<string | null>(null);
  const [submissionSourceId, setSubmissionSourceId] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const pendingViewFocus = useRef(false);
  const pendingDeleteFocus = useRef<"confirm" | "restore" | null>(null);
  const selected = useMemo(() => skills.find((item) => item.id === selectedId) ?? null, [skills, selectedId]);
  const dirty = (mode === "create" || mode === "edit") && JSON.stringify(editor) !== baseline;
  const conflict = mode === "edit" && selected && conflictSkillId === selected.id ? selected : null;
  // Keep the tab guard in sync with local edits, including edits loaded from a file.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => {
    if (!pendingViewFocus.current) return;
    const target = (visibleMode === "list" ? listHeadingRef : viewHeadingRef).current;
    if (!target) return;
    pendingViewFocus.current = false;
    target.focus();
  }, [visibleMode, selectedId, skills]);
  useLayoutEffect(() => {
    if (!pendingDeleteFocus.current) return;
    const target = pendingDeleteFocus.current;
    pendingDeleteFocus.current = null;
    (target === "confirm" ? deleteConfirmRef : deleteTriggerRef).current?.focus();
  }, [confirmDelete]);

  const lockScope = useCallback((expired = false) => {
    setScopeMismatch(true);
    setSessionExpired(expired);
    setSkills([]);
    setSelectedId(null);
    setEditor({ kind: "inline", content: emptyContent });
    setMode("list");
    setError(null);
    setReviewedRevision(null);
    setHistory(null);
  }, []);
  const checkScope = useCallback((scope: PersonalSkillScope) => {
    if (scope.tenantId === expectedScope.tenantId && scope.userId === expectedScope.userId) return true;
    lockScope();
    return false;
  }, [expectedScope.tenantId, expectedScope.userId, lockScope]);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.code === "personal_skill_scope_changed")) {
      lockScope(cause.status === 401);
      return;
    }
    setError(message(cause));
  }, [lockScope]);
  const reload = useCallback(async (keepEditor = false) => {
    if (scopeMismatch) return null;
    setLoading(true);
    try {
      const result = await getPersonalSkills();
      if (!checkScope(result.scope)) return null;
      setSkills(result.skills);
      setHistory(null);
      if (!keepEditor) setError(null);
      return result.skills;
    } catch (cause) {
      handleError(cause);
      return null;
    } finally { setLoading(false); }
  }, [checkScope, handleError, scopeMismatch]);
  useEffect(() => {
    let active = true;
    getPersonalSkills().then((result) => {
      if (!active || !checkScope(result.scope)) return;
      setSkills(result.skills);
    }).catch((cause: unknown) => { if (active) handleError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [checkScope, handleError]);
  const replaceSkill = (skill: PersonalSkill) => {
    setSkills((current) => [...current.filter((item) => item.id !== skill.id), skill]
      .sort((a, b) => a.latest.content.name.localeCompare(b.latest.content.name)));
    setSelectedId(skill.id);
    setHistory(null);
  };
  const beginCreate = () => {
    pendingViewFocus.current = true;
    const next: Editor = { kind: "inline", content: { ...emptyContent } };
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(null);
    setMode("create"); setError(null); setReviewedRevision(null); setConfirmDelete(false); setHistory(null);
  };
  const beginEdit = (skill: PersonalSkill) => {
    pendingViewFocus.current = true;
    const next: Editor = { kind: "inline", content: { ...skill.latest.content } };
    setEditor(next); setBaseline(JSON.stringify(next)); setSelectedId(skill.id);
    setMode("edit"); setError(null); setReviewedRevision(null); setConfirmDelete(false); setHistory(null);
    setConflictSkillId(null);
  };
  const cancelEdit = () => {
    if (dirty && !window.confirm("Discard your unsaved skill changes?")) return;
    pendingViewFocus.current = true;
    setMode(selectedId ? "details" : "list"); setError(null);
    setReviewedRevision(null); setConflictSkillId(null);
  };
  const run = async (work: () => Promise<void>) => {
    if (busy || loading || scopeMismatch) return;
    setBusy(true); setError(null);
    try { await work(); } catch (cause) {
      if (cause instanceof ApiError && ((cause.status === 409 && cause.code === "personal_skill_conflict") || cause.status === 404)) {
        const reloaded = await reload(true);
        setReviewedRevision(null);
        if (reloaded) {
          if (selectedId && !reloaded.some((item) => item.id === selectedId)) {
            pendingViewFocus.current = true;
            setSelectedId(null);
            setMode(mode === "edit" ? "create" : "list");
            setError(mode === "edit"
              ? "This skill was deleted elsewhere. Your text is still here. Save it as a new draft if you want to keep it."
              : "This skill was deleted elsewhere. It is no longer in your list.");
          } else {
            if (mode === "edit" && cause.status === 409) setConflictSkillId(selectedId);
            setError(`${message(cause)} Review the current version before you try again.${mode === "edit" || mode === "create" ? " Your unsaved text is still here." : ""}`);
          }
        }
      } else handleError(cause);
    } finally { setBusy(false); }
  };
  const save = () => void run(async () => {
    const payload = source(editor);
    const result = mode === "create"
      ? await createPersonalSkill({ scope: expectedScope, source: payload })
      : selected && await updatePersonalSkill(selected.id, { scope: expectedScope, source: payload, version: selected.version });
    if (!result || !checkScope(result.scope)) return;
    pendingViewFocus.current = true;
    replaceSkill(result.skill); setMode("review"); setReviewedRevision(null);
    setBaseline(JSON.stringify(editor));
  });
  const act = (action: "release" | "disable") => {
    if (!selected) return;
    void run(async () => {
      const result = await actOnPersonalSkill(selected.id, { scope: expectedScope, version: selected.version, action });
      if (!checkScope(result.scope)) return;
      pendingViewFocus.current = true;
      replaceSkill(result.skill); setMode("details"); setReviewedRevision(null);
      onChanged?.();
    });
  };
  const remove = () => {
    if (!selected || !confirmDelete) return;
    void run(async () => {
      const result = await deletePersonalSkill(selected.id, { scope: expectedScope, version: selected.version });
      if (!checkScope(result.scope)) return;
      pendingViewFocus.current = true;
      setSkills((current) => current.filter((item) => item.id !== selected.id));
      setSelectedId(null); setMode("list"); setConfirmDelete(false); setHistory(null); onChanged?.();
    });
  };
  const showHistory = () => {
    if (!selected) return;
    void run(async () => {
      const result = await getPersonalSkillHistory(selected.id);
      if (!checkScope(result.scope)) return;
      setHistory(result.revisions);
    });
  };
  const switchEditor = (kind: Editor["kind"]) => {
    if (kind === editor.kind) return;
    if (dirty && !window.confirm("Discard the text you entered?")) return;
    const next: Editor = kind === "inline" ? { kind, content: { ...emptyContent } } : { kind, markdown: "" };
    setEditor(next); setBaseline(JSON.stringify(next)); setError(null);
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    setReadingFile(true);
    try {
      setEditor({ kind: "markdown", markdown: await readSkillMarkdownFile(file) }); setError(null);
    } catch (cause) { setError(message(cause)); }
    finally { setReadingFile(false); }
  };
  const disabled = busy || loading || readingFile || scopeMismatch;


  return <section aria-labelledby="private-skills-title" className="space-y-5 pt-5">
    {visibleMode === "submissions" && !scopeMismatch ? <OrganizationSkillSubmissions expectedScope={expectedScope} skills={skills} initialSkillId={submissionSourceId} requestedSubmissionId={requestedSubmissionId} onBack={() => { setMode("list"); setSubmissionSourceId(null); pendingViewFocus.current = true; }} /> : null}
    {visibleMode !== "submissions" ? <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2">
        <h2 ref={listHeadingRef} tabIndex={-1} id="private-skills-title" className="text-base font-semibold text-on-surface">Private skills</h2>
        <p className="text-sm text-on-surface-variant">Write or import instructions for your own standalone chats. Only you can use these skills. Projects and scheduled jobs do not use them.</p>
      </div>
      {mode === "list" ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => { setSubmissionSourceId(null); setMode("submissions"); }}>My submissions</Button><Button size="sm" disabled={disabled} onClick={beginCreate}>Create skill</Button></div> : null}
    </div>
    {scopeMismatch ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{sessionExpired ? "Your session expired. Sign in again, then reload this page to edit private skills." : "Your account or organization changed. Reload this page before editing private skills."}</p><Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button></div> : null}
    {error && !scopeMismatch ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{error}</p>{mode === "list" ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => void reload()}>Reload skills</Button> : null}</div> : null}
    {loading && skills.length === 0 && !scopeMismatch ? <div aria-label="Loading private skills" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : null}
    {!loading && mode === "list" && !scopeMismatch ? skills.length === 0
      ? <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-6 text-sm text-on-surface-variant">No private skills yet. Create one, then review it before making it available in your chats.</div>
      : <ul className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">{skills.map((skill) => <li key={skill.id} className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-on-surface">{skill.latest.content.name}</h3><span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">{status(skill)}</span>{skill.active && skill.latest.revision !== skill.active.revision ? <span className="text-xs text-on-surface-variant">New draft</span> : null}</div><p className="max-w-xl break-words text-sm text-on-surface-variant">{skill.latest.content.description}</p></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => { pendingViewFocus.current = true; setSelectedId(skill.id); setMode("details"); setError(null); setHistory(null); }}>Details</Button><Button size="sm" disabled={disabled} onClick={() => {
          if (skill.active && skill.latest.revision === skill.active.revision) beginEdit(skill);
          else { pendingViewFocus.current = true; setSelectedId(skill.id); setMode("review"); setReviewedRevision(null); setError(null); setHistory(null); }
        }}>{skill.active && skill.latest.revision === skill.active.revision ? "Edit" : "Review"}</Button></div>
      </li>)}</ul> : null}
    {(mode === "create" || mode === "edit") && !scopeMismatch ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={viewHeadingRef} tabIndex={-1} className="font-semibold">{mode === "create" ? "Create a draft" : `Edit ${selected?.latest.content.name ?? "skill"}`}</h3><Button size="sm" variant="ghost" disabled={disabled} onClick={cancelEdit}>Cancel</Button></div>
      <SkillSourceFields idPrefix="skill" editor={editor} disabled={disabled} onChange={setEditor} onSwitch={switchEditor} onFile={(file) => void readFile(file)} />
      {conflict ? <SkillConflictChoice content={conflict.latest.content} disabled={disabled} onKeep={() => { setConflictSkillId(null); setError(null); }} onUseLatest={() => beginEdit(conflict)} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4"><Button size="sm" disabled={disabled || Boolean(conflict) || !skillEditorComplete(editor) || (mode === "edit" && !dirty)} onClick={save}>{busy ? "Saving…" : "Save draft"}</Button><span className="text-xs text-on-surface-variant">Saving a draft does not make it available in chats. An active revision stays in use until you release this draft.</span></div>
    </div> : null}
    {(mode === "review" || mode === "details") && selected && !scopeMismatch ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-on-surface-variant">{status(selected)} · Revision {selected.active?.revision ?? selected.latest.revision}</p>{selected.active && selected.latest.revision !== selected.active.revision ? <p className="text-xs text-on-surface-variant">Draft revision {selected.latest.revision} is ready to review.</p> : null}<h3 ref={viewHeadingRef} tabIndex={-1} className="mt-1 text-lg font-semibold">{selected.latest.content.name}</h3><p className="mt-1 text-sm text-on-surface-variant">{selected.latest.content.description}</p></div><Button size="sm" variant="ghost" disabled={disabled} onClick={() => { pendingViewFocus.current = true; setMode("list"); setSelectedId(null); setConfirmDelete(false); setHistory(null); setError(null); }}>Back to skills</Button></div>
      {selected.enabled && selected.active && selected.active.revision !== selected.latest.revision ? <p className="text-sm text-on-surface-variant">Your current chats still use revision {selected.active.revision} while this draft waits for review.</p> : null}
      <SkillInstructions title="Instructions to review" text={selected.latest.content.instructions} />
      <SkillValidation messages={selected.latest.validationMessages} />
      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4"><Button size="sm" disabled={disabled} onClick={() => { setSubmissionSourceId(selected.id); setMode("submissions"); }}>Share with organization</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => beginEdit(selected)}>Edit</Button><Button size="sm" variant="outline" disabled={disabled} onClick={showHistory}>History</Button>{selected.enabled ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => act("disable")}>Turn off</Button> : null}<Button ref={deleteTriggerRef} size="sm" variant="ghost" disabled={disabled} onClick={() => { pendingDeleteFocus.current = "confirm"; setConfirmDelete(true); }}>Delete</Button></div>
      {(mode === "review" || !selected.enabled || selected.latest.revision !== selected.active?.revision) ? <div className="space-y-3 rounded-md border border-outline-variant bg-surface p-4"><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={reviewedRevision === selected.latest.revision} disabled={disabled} onChange={(event) => setReviewedRevision(event.target.checked ? selected.latest.revision : null)} /><span>I reviewed this revision and its validation messages.</span></label><Button size="sm" disabled={disabled || reviewedRevision !== selected.latest.revision} onClick={() => act("release")}>Make available for my chats</Button><p className="text-xs text-on-surface-variant">Release adds this skill to your chat defaults. Chats with a saved skill selection need you to add it there too.</p></div> : null}
      {confirmDelete ? <div role="group" aria-label="Confirm deletion" className="flex flex-wrap items-center gap-2 rounded-md border border-danger p-3 text-sm"><span>Delete this skill and its history?</span><Button ref={deleteConfirmRef} size="sm" variant="destructive" disabled={disabled} onClick={remove}>Delete skill</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => { pendingDeleteFocus.current = "restore"; setConfirmDelete(false); }}>Keep skill</Button></div> : null}
      {history ? <SkillHistory revisions={history} /> : null}
    </div> : null}
    </> : null}
  </section>;
}
