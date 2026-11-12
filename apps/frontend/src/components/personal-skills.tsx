"use client";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import type { PersonalSkill, PersonalSkillScope } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { OrganizationSkillSubmissions } from "./organization-skill-submissions";
import {
  skillEditorComplete, SkillConflictChoice, skillFocusRing, SkillHistory, SkillInstructions, SkillNotice, SkillSourceFields, SkillValidation
} from "./skill-editor-parts";
import type { FocusRequest, Operation } from "./personal-skills-state";
import { usePersonalSkills, type FocusProbe } from "./use-personal-skills";

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
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const pendingDeleteFocus = useRef<"confirm" | "restore" | null>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const fileStatusRef = useRef<HTMLParagraphElement>(null);
  const pendingFileFocus = useRef(false);
  const discardedView = useRef(false);
  const appliedFocus = useRef<FocusRequest | null>(null);
  // The decision block of each operation: its trigger, its consequence and its result.
  const saveBlock = useRef<HTMLDivElement>(null), releaseBlock = useRef<HTMLDivElement>(null);
  const disableBlock = useRef<HTMLDivElement>(null), deleteBlock = useRef<HTMLDivElement>(null), historyBlock = useRef<HTMLDivElement>(null);
  const focusProbe = useMemo<FocusProbe>(() => ({
    capture: () => document.activeElement,
    owns: (trigger) => document.activeElement === trigger || document.activeElement === document.body,
    ownsRecovery: () => {
      const element = document.activeElement;
      return element === document.body || Boolean(element?.hasAttribute("data-skill-action")) || Boolean(recoveryRef.current?.contains(element));
    }
  }), []);
  const controller = usePersonalSkills({ expectedScope, requestedSubmissionId, focusProbe, onChanged, onDirtyChange });
  const { state, dispatch, visible, selected, conflict, reviewed, dirty, readingFile } = controller;
  const active = state.status === "active" ? state : null;
  const locked = state.status === "locked";
  const view = active?.view ?? null;
  const skills = active?.skills ?? [];
  const loading = active?.list.loading ?? false;
  const listReadError = active?.list.error ?? null;
  const pending = active?.pending ?? null;
  const recovery = active?.recovery ?? null;
  const busy = pending !== null;
  const editorView = view?.kind === "create" || view?.kind === "edit" ? view : null;
  const skillView = view?.kind === "details" || view?.kind === "review" ? view : null;
  const notice = editorView?.notice ?? skillView?.notice ?? (view?.kind === "list" ? view.notice : null);
  const actionError = editorView?.actionError ?? skillView?.actionError ?? null;
  const discard = editorView?.discard ?? null;
  const confirmDelete = skillView?.confirmDelete ?? false;
  const conflictSkill = conflict ? selected : null;

  // Applies each focus request once. A heading request waits until its heading
  // renders, for example after a requested submission closes. The others apply
  // at once or not at all.
  useLayoutEffect(() => {
    const request = state.focus;
    if (!request || appliedFocus.current === request) return;
    if (request.target === "heading") {
      const heading = (visible === "list" || visible === "locked" ? listHeadingRef : viewHeadingRef).current;
      if (!heading) return;
      appliedFocus.current = request;
      heading.focus();
      return;
    }
    appliedFocus.current = request;
    if (request.target === "reveal") {
      // Bring a result into view next to its trigger. The controller checked that the trigger kept focus.
      const blocks = { save: saveBlock, release: releaseBlock, disable: disableBlock, delete: deleteBlock, history: historyBlock };
      blocks[request.block].current?.scrollIntoView?.({ block: "nearest" });
    } else (request.target === "recovery" ? recoveryRef : conflictRef).current?.focus();
  });
  useLayoutEffect(() => {
    if (!pendingDeleteFocus.current) return;
    const target = pendingDeleteFocus.current;
    pendingDeleteFocus.current = null;
    const button = (target === "confirm" ? deleteConfirmRef : deleteTriggerRef).current;
    if (button?.disabled) recoveryRef.current?.focus();
    else button?.focus();
  }, [confirmDelete]);
  useLayoutEffect(() => {
    if (!pendingFileFocus.current) return;
    if (readingFile) fileStatusRef.current?.focus();
    else {
      pendingFileFocus.current = false;
      if (document.activeElement === document.body) document.getElementById("skill-file")?.focus({ preventScroll: true });
    }
  }, [readingFile]);

  const readFile = (file?: File) => {
    const fromInput = document.activeElement === document.getElementById("skill-file");
    if (controller.readFile(file)) pendingFileFocus.current = fromInput;
  };
  const disabled = busy || loading || readingFile || locked;
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
    <p className={prose}>{editorView ? "Your unsaved text is still here. " : ""}Reload the latest version before saving, releasing, turning off, or deleting this skill.</p>
    <Button data-skill-action="latest" size="sm" variant="outline" aria-disabled={pending === "latest"} disabled={disabled && pending !== "latest"} onClick={controller.reloadLatest}><Pending active={pending === "latest"} idle="Reload latest version" busy="Reloading latest version…" /></Button>
  </SkillNotice> : null;
  const saveNote = editorView?.kind === "create" || !selected?.active ? "Saving a draft does not make it available in chats. You review it before release."
    : selected.enabled ? `Saving creates a new draft. Revision ${selected.active.revision} stays in use until you release the draft.`
      : "Saving creates a new draft. This skill stays off until you release a revision.";
  const historyId = selected ? `private-skill-history-${selected.id}` : undefined;
  const historyOpen = skillView?.historyOpen ?? false;
  const history = skillView?.history ?? null;
  const name = selected?.latest.content.name ?? "";
  const revision = selected?.latest.revision ?? 0;
  const release = selected ? releaseCopy(selected) : null;
  const releasable = Boolean(selected && (skillView?.kind === "review" || !selected.enabled || hasNewDraft(selected)));

  return <section aria-labelledby={visible === "submissions" ? "submission-title" : "private-skills-title"} className="space-y-5 pt-5 [overflow-wrap:anywhere]">
    {visible === "submissions" ? <OrganizationSkillSubmissions expectedScope={expectedScope} skills={skills} initialSkillId={view?.kind === "submissions" ? view.sourceSkillId : null} requestedSubmissionId={requestedSubmissionId} onDirtyChange={controller.setSubmissionDirty} onPendingChange={onSubmissionPendingChange} onBack={() => dispatch({ type: "openList" })} /> : null}
    {visible !== "submissions" ? <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2">
        <h2 ref={listHeadingRef} tabIndex={-1} id="private-skills-title" className={`text-base font-semibold text-on-surface ${headingFocus}`}>Private skills</h2>
        <p className="text-sm text-on-surface-variant">Write or import instructions for your own standalone chats. Only you can use these skills. Projects and scheduled jobs do not use them.</p>
      </div>
      {visible === "list" || locked ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => dispatch({ type: "openSubmissions", sourceSkillId: null })}>My submissions</Button><Button size="sm" className={quietDisabled} disabled={disabled || Boolean(recovery)} onClick={() => dispatch({ type: "openCreate" })}>Create skill</Button></div> : null}
    </div>
    {state.status === "locked" ? <SkillNotice role="alert" tone="danger" title={state.reason === "session_expired" ? "Your session expired" : "Your account or organization changed"}>
      <p>{state.reason === "session_expired" ? "Reload this page to sign in again." : "Reload this page before editing private skills."}</p>
      <p>Unsaved text was cleared to protect your private skills.</p>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
    </SkillNotice> : null}
    {visible === "list" ? <>
      {viewNotice}
      {listReadError ? null : recoveryBlock}
      {listReadError ? <SkillNotice role="alert" tone="danger" title={skills.length > 0 ? "Could not load the full skills list" : "Could not load private skills"}>
        <p className={prose}>{listReadError}</p>
        {recovery ? <p className={prose}>Reload skills before you create or change a skill.</p> : null}
        <Button data-skill-action="reload" size="sm" variant="outline" aria-disabled={loading} disabled={busy || readingFile || locked} onClick={controller.reloadList}><Pending active={loading} idle="Reload skills" busy="Reloading skills…" /></Button>
        {skills.length > 0 ? <p role={loading ? "status" : undefined} className={prose}>{loading ? "Reloading skills. The list below shows the last confirmed items." : "Only skills confirmed in this session are shown below."}</p> : null}
      </SkillNotice> : null}
      {loading && skills.length > 0 && !listReadError ? <p role="status" className="text-sm text-on-surface-variant">Reloading skills. The list below shows the last confirmed items.</p> : null}
      {loading && skills.length === 0 ? <div className="space-y-2"><p role="status" className="flex items-center gap-2 text-sm text-on-surface-variant"><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Loading private skills…</p><div aria-hidden="true" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div></div> : null}
      {!loading && !listReadError && skills.length === 0
        ? <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-6 text-sm text-on-surface-variant">No private skills saved. Create one, then review it before making it available in your chats.</div> : null}
      {skills.length > 0 ? <ul aria-busy={loading} className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">{skills.map((skill) => {
        const editable = skill.active && !hasNewDraft(skill);
        return <li key={skill.id} className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1 basis-60 space-y-1">
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-on-surface">{skill.latest.content.name}</h3><span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">{status(skill)}</span>{skill.active && hasNewDraft(skill) ? <span className="text-xs text-on-surface-variant">Draft revision {skill.latest.revision} to review</span> : null}</div>
            {/* Two lines in the list. Details show the full purpose. */}
            <p className={`line-clamp-2 whitespace-pre-wrap text-sm text-on-surface-variant ${prose}`}>{skill.latest.content.description}</p>
          </div>
          <div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => dispatch({ type: "openSkill", skillId: skill.id, kind: "details" })}>Details</Button><Button size="sm" className={quietDisabled} disabled={disabled || Boolean(editable && recovery)} onClick={() => dispatch(editable ? { type: "openEdit", skillId: skill.id } : { type: "openSkill", skillId: skill.id, kind: "review" })}>{editable ? "Edit" : "Review"}</Button></div>
        </li>;
      })}</ul> : null}
    </> : null}
    {editorView ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={viewHeadingRef} tabIndex={-1} className={`font-semibold ${headingFocus}`}>{editorView.kind === "create" ? "Create a draft" : `Edit ${selected?.latest.content.name ?? "skill"}`}</h3><Button size="sm" variant="ghost" disabled={disabled} onClick={() => dispatch({ type: "cancelEditor" })}>Cancel</Button></div>
      {viewNotice}
      {readingFile ? <p ref={fileStatusRef} tabIndex={-1} role="status" className={`text-sm text-on-surface-variant ${headingFocus}`}>Reading SKILL.md…</p> : null}
      <SkillSourceFields idPrefix="skill" editor={editorView.editor} disabled={disabled} onChange={(editor) => dispatch({ type: "editorChanged", editor })} onSwitch={(kind) => dispatch({ type: "sourceSwitched", kind })} onFile={readFile}
        fileMessage={editorView.fileError ? <SkillNotice role="alert" tone="danger" title="Could not use this file"><p>{editorView.fileError}</p></SkillNotice> : null} />
      {recoveryBlock}
      {conflictSkill ? <div ref={conflictRef} tabIndex={-1} className={`rounded-md ${skillFocusRing}`}><SkillConflictChoice content={conflictSkill.latest.content} explanation="Your draft was not saved. Your unsaved text is still here. Compare it with the saved version, then choose which one to keep." disabled={disabled} onKeep={() => dispatch({ type: "keepMyText" })} onUseLatest={() => dispatch({ type: "useLatest" })} /></div> : null}
      <div ref={saveBlock} className="space-y-3 border-t border-outline-variant pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><Button className={quietDisabled} data-skill-action="save" aria-describedby={describedBy("save")} size="sm" aria-disabled={pending === "save"} disabled={(disabled && pending !== "save") || conflict || Boolean(recovery) || !skillEditorComplete(editorView.editor) || (editorView.kind === "edit" && !dirty)} onClick={controller.save}><Pending active={pending === "save"} idle="Save draft" busy="Saving draft…" /></Button><span className={`text-sm text-on-surface-variant ${prose}`}>{saveNote}</span></div>
        {errorFor("save")}
      </div>
    </div> : null}
    {skillView && selected && release ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1"><h3 ref={viewHeadingRef} tabIndex={-1} className={`text-lg font-semibold ${headingFocus}`}>{name}</h3><p className={`whitespace-pre-wrap text-sm text-on-surface-variant ${prose}`}>{selected.latest.content.description}</p></div>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => dispatch({ type: "openList" })}>Back to skills</Button>
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
          <label className="flex min-h-10 items-start gap-2 py-2 text-sm"><span className="relative mt-0.5 inline-flex size-4 shrink-0"><input type="checkbox" className={`peer size-4 appearance-none rounded-sm border border-input bg-control checked:border-primary checked:bg-primary disabled:opacity-50 ${skillFocusRing}`} checked={reviewed} disabled={disabled} onChange={(event) => dispatch({ type: "reviewMarked", reviewed: event.target.checked })} /><CheckIcon aria-hidden="true" className="pointer-events-none absolute inset-0 hidden size-4 text-primary-foreground peer-checked:block" /></span><span>I reviewed revision {revision} and its validation messages.</span></label>
          <Button size="sm" className={quietDisabled} data-skill-action="release" aria-describedby={describedBy("release")} aria-disabled={pending === "release"} disabled={(disabled && pending !== "release") || Boolean(recovery) || !reviewed} onClick={() => controller.act("release")}><Pending active={pending === "release"} idle={`Make revision ${revision} available${selected.active?.revision === revision && !selected.enabled ? " again" : ""}`} busy={`Making revision ${revision} available…`} /></Button>
          {errorFor("release")}
        </div> : null}
        <div ref={historyBlock} className="space-y-3 border-t border-outline-variant pt-5">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={disabled || Boolean(recovery)} onClick={() => dispatch({ type: "openEdit", skillId: selected.id })}>Edit</Button>
            <Button data-skill-action="history" aria-describedby={describedBy("history")} size="sm" variant="outline" aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} aria-disabled={pending === "history"} disabled={disabled && pending !== "history"} onClick={controller.toggleHistory}>
              {pending === "history" ? <Pending active idle="History" busy="Loading history…" /> : <>History<ChevronDownIcon aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${historyOpen ? "rotate-180" : ""}`} /></>}
            </Button>
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => dispatch({ type: "openSubmissions", sourceSkillId: selected.id })}>Share with organization</Button>
          </div>
          {errorFor("history")}
          {historyOpen && history ? <SkillHistory id={historyId} revisions={history} markers={(item) => [
            ...(item.revision === selected.active?.revision ? [selected.enabled ? "In use" : "Off"] : []),
            ...(item.revision === revision && hasNewDraft(selected) ? ["Latest draft"] : [])
          ]} /> : null}
        </div>
        <div className="divide-y divide-outline-variant border-t border-outline-variant">
          {selected.enabled && selected.active ? <div ref={disableBlock} className="space-y-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><p className={`min-w-0 flex-1 basis-56 text-sm text-on-surface-variant ${prose}`}>Turn off makes this skill unavailable for your chats. Revision {selected.active.revision} stays saved, and you can make a revision available again later.</p><Button data-skill-action="disable" aria-describedby={describedBy("disable")} size="sm" variant="outline" aria-disabled={pending === "disable"} disabled={(disabled && pending !== "disable") || Boolean(recovery)} onClick={() => controller.act("disable")}><Pending active={pending === "disable"} idle="Turn off" busy="Turning off…" /></Button></div>
            {errorFor("disable")}
          </div> : null}
          <div ref={deleteBlock} className="space-y-3 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><p className={`min-w-0 flex-1 basis-56 text-sm text-on-surface-variant ${prose}`}>Delete removes this skill and all its revisions.</p><Button ref={deleteTriggerRef} size="sm" variant="outline" aria-expanded={confirmDelete} disabled={disabled || Boolean(recovery)} onClick={() => { pendingDeleteFocus.current = "confirm"; dispatch({ type: "deleteConfirmation", open: true }); }}>Delete</Button></div>
            {confirmDelete ? <SkillNotice role="group" aria-label="Confirm deletion" tone="danger" title={<>Delete <strong>{name}</strong>?</>}>
              <p className={prose}>This deletes its revision history and removes it from your skills and chat defaults. This cannot be undone.</p>
              <div className="flex flex-wrap gap-2"><Button ref={deleteConfirmRef} data-skill-action="delete" aria-describedby={describedBy("delete")} size="sm" variant="destructive" aria-disabled={pending === "delete"} disabled={(disabled && pending !== "delete") || Boolean(recovery)} onClick={controller.remove}><Pending active={pending === "delete"} idle="Delete skill" busy="Deleting skill…" /></Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => { pendingDeleteFocus.current = "restore"; dispatch({ type: "deleteConfirmation", open: false }); }}>Keep skill</Button></div>
              {errorFor("delete", true)}
            </SkillNotice> : null}
          </div>
        </div>
      </div> : null}
    <AlertDialog open={discard !== null} onOpenChange={(open) => { if (!open) dispatch({ type: "discardDismissed" }); }}>
      <AlertDialogContent onCloseAutoFocus={(event) => {
        if (discardedView.current || locked) {
          event.preventDefault();
          discardedView.current = false;
          (skillView ? viewHeadingRef : listHeadingRef).current?.focus();
        }
      }}>
        <AlertDialogHeader><AlertDialogTitle>Discard unsaved skill changes?</AlertDialogTitle><AlertDialogDescription>{discard === "cancel" ? "Your unsaved text will be removed. Saved revisions stay unchanged." : "Switching the source removes the text you entered. Saved revisions stay unchanged."}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => {
          if (discard === "cancel") discardedView.current = true;
          dispatch({ type: "discardConfirmed" });
        }}>Discard changes</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {pending ? <p role="status" className="sr-only">{pending === "history" ? "Loading revision history…" : pending === "delete" ? `Deleting ${selected?.latest.content.name ?? "skill"} and its revision history…` : pending === "latest" ? "Reloading the current skill version…" : pending === "save" ? "Saving your draft…" : pending === "disable" ? "Turning off this skill for your chats…" : `Making revision ${selected?.latest.revision ?? ""} available for your chats…`}</p> : null}
    </> : null}
  </section>;
}
