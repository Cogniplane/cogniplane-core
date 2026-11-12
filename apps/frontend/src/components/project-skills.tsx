"use client";

import type { ProjectSkill, ProjectSkillScope } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectSkillEditor } from "@/hooks/use-project-skill-editor";
import type { ProjectSkillOperation as Operation } from "./project-skills.logic";
import { skillEditorComplete, SkillConflictChoice, SkillHistory, SkillInstructions, SkillNotice, SkillSourceFields,
  SkillValidation, skillFocusRing } from "./skill-editor-parts";

const status = (skill: ProjectSkill) => skill.enabled && skill.active ? "Released in this project" : skill.active ? "Off" : "Draft";
type Props = {
  scope: ProjectSkillScope; projectName: string; archived: boolean; canManage: boolean;
  onChanged?: () => void; onAccessFailure?: () => Promise<unknown>;
};

export function ProjectSkills(props: Props) {
  // Changing account or project discards the previous scope's draft and requests.
  return <ProjectSkillsView key={JSON.stringify([props.scope.tenantId, props.scope.userId, props.scope.projectId])} {...props} />;
}

function ProjectSkillsView(props: Props) {
  const { projectName, archived } = props;
  const {
    heading, historyButton, mode, selected, editor, skills, personal, copyCandidate, sourceCandidate, history, confirmDelete,
    loading, readFailed, pending, readingFile, busy, locked, expired, error, errorAt, notice, fileError,
    editable, disabled, actionDisabled, dirty, conflict, reviewed,
    beginCreate, openDetails, beginEdit, chooseLatestVersion, keepLocalText, changeDraft, switchSource, cancel, back,
    setReview, setDeleteConfirmation, reloadSkills, closeHistory, save, act, remove, openCopy, chooseCopy, copy,
    inspectSource, updateSource, showHistory, readFile
  } = useProjectSkillEditor(props);
  const feedback = (operation: Operation) => error && !readFailed && errorAt === operation
    ? <SkillNotice role="alert" tone={conflict ? "attention" : "danger"} title={conflict ? "Review the latest revision" : "Request did not complete"}><p>{error}</p>{operation === "save" ? <p>Your draft text is kept. Save again after you review any newer revision and the service is available.</p> : null}</SkillNotice> : null;
  const label = (operation: Operation, idle: string, active: string) => pending === operation ? active : idle;
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
      <Button size="sm" variant="outline" disabled={busy || loading} onClick={reloadSkills}>{loading ? "Reloading skills…" : "Reload skills"}</Button>
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
        <Button size="sm" variant="outline" disabled={busy} onClick={() => openDetails(skill.id)}>Details</Button>
      </li>)}</ul> : <p className="text-sm text-on-surface-variant">No project skills yet. An owner can create a draft or copy a released private skill.</p>}
    </> : null}
    {editor && !locked ? <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><h4 ref={heading} tabIndex={-1} className={viewHeading}>{mode === "create" ? `Create a draft in ${projectName}` : `Edit ${selected?.latest.content.name}`}</h4><Button size="sm" variant="ghost" disabled={busy || readingFile} onClick={cancel}>Cancel</Button></div>
      {mode === "edit" && selected ? <p className="text-sm text-on-surface-variant">Editing draft revision {selected.latest.revision}.{selected.active ? ` Released revision ${selected.active.revision} stays ${selected.enabled ? "available" : "off"} until you release a change.` : " No revision is released yet."}</p> : null}
      <SkillSourceFields idPrefix="project-skill" editor={editor} disabled={disabled} onChange={changeDraft} onSwitch={switchSource} onFile={file => void readFile(file)} fileMessage={fileError ? <p role="alert" className="text-sm text-danger">{fileError}</p> : readingFile ? <p role="status" className="text-sm">Reading SKILL.md…</p> : null} />
      {conflict ? <SkillConflictChoice content={conflict.latest.content} disabled={disabled} onKeep={keepLocalText} onUseLatest={chooseLatestVersion} /> : null}
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
        <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed.copy} onChange={event => setReview("copy", event.target.checked)} />I reviewed this released revision {copyCandidate.active.revision} before copying it into {projectName}.</label>
        <Button size="sm" disabled={actionDisabled("copy", !reviewed.copy)} aria-disabled={pending === "copy"} onClick={copy}>{label("copy", "Create project draft", "Copying revision…")}</Button>
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
          {editable ? <Button size="sm" variant="outline" disabled={disabled} onClick={beginEdit}>Edit draft</Button> : null}
          <Button ref={historyButton} size="sm" variant="outline" disabled={loading || (busy && pending !== "history")} aria-disabled={pending === "history"} aria-expanded={history !== null} aria-controls="project-skill-history" onClick={() => history ? closeHistory() : showHistory()}>{label("history", "History", "Loading history…")}</Button>
          {editable && selected.enabled ? <Button size="sm" variant="outline" disabled={actionDisabled("disable")} aria-disabled={pending === "disable"} onClick={() => act("disable")}>{label("disable", "Turn off", "Turning off…")}</Button> : null}
          {editable ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDeleteConfirmation(true)}>Delete</Button> : null}
        </div>
        {feedback("disable")}{feedback("history")}{!confirmDelete ? feedback("delete") : null}
        {history ? <div className="space-y-3" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeHistory(); } }}><div className="flex justify-end"><Button size="sm" variant="ghost" onClick={closeHistory}>Close history</Button></div><SkillHistory id="project-skill-history" revisions={history} markers={revision => [revision.revision === selected.latest.revision ? "Latest saved" : "", revision.revision === selected.active?.revision ? selected.enabled ? "Released" : "Off" : ""].filter(Boolean)} note={revision => revision.copiedFromRevision ? `Copied from private revision ${revision.copiedFromRevision}` : null} /></div> : null}
      </div>
      {editable && (!selected.enabled || newDraft) ? <div className="space-y-3 rounded-md bg-surface-container-low p-4">
        <h5 className="text-sm font-semibold">{newDraft ? `Review draft revision ${selected.latest.revision} for release` : `Release revision ${selected.latest.revision} again`}</h5>
        <p className="max-w-[64ch] text-sm text-on-surface-variant">{selected.active && newDraft ? `Release replaces revision ${selected.active.revision} with revision ${selected.latest.revision}.` : `Release makes revision ${selected.latest.revision} available.`} The change applies on the next turn when the skill is selected.</p>
        <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed.release} onChange={event => setReview("release", event.target.checked)} />I reviewed this draft revision {selected.latest.revision} and its validation messages.</label>
        <Button size="sm" disabled={actionDisabled("release", !reviewed.release)} aria-disabled={pending === "release"} onClick={() => act("release")}>{label("release", `Release in ${projectName}`, `Releasing revision ${selected.latest.revision}…`)}</Button>
        <p className="max-w-[64ch] text-xs text-on-surface-variant">Release adds this skill to a custom project selection. Chats with saved selections need you to add it there too.</p>{feedback("release")}
      </div> : null}
      {editable && selected.copiedFrom?.mine && selected.copiedFrom.personalSkillId ? <div className="space-y-3 border-t border-outline-variant pt-4">
        <Button size="sm" variant="outline" disabled={actionDisabled("source-read")} aria-disabled={pending === "source-read"} onClick={inspectSource}>{label("source-read", "Check my private source", "Loading private source…")}</Button>{feedback("source-read")}{feedback("source-update")}
        {sourceCandidate?.active ? <div className="space-y-3"><p className="text-sm font-medium">Released private revision {sourceCandidate.active.revision}. Updating creates a project draft.</p><SkillInstructions title="Private source instructions" text={sourceCandidate.active.content.instructions} /><SkillValidation messages={sourceCandidate.active.validationMessages} />
          <label className="flex max-w-[64ch] items-start gap-3 text-sm"><input type="checkbox" className={checkbox} disabled={disabled} checked={reviewed.sourceUpdate} onChange={event => setReview("source-update", event.target.checked)} />I reviewed this private revision {sourceCandidate.active.revision} for project draft {selected.latest.revision}.</label>
          <Button size="sm" className="h-auto min-h-8 whitespace-normal text-left" disabled={actionDisabled("source-update", !reviewed.sourceUpdate)} aria-disabled={pending === "source-update"} onClick={updateSource}>{label("source-update", "Create draft from private source", "Updating project draft…")}</Button>
        </div> : null}
      </div> : null}
      {confirmDelete && editable ? <SkillNotice role="group" aria-label="Confirm deletion" className="break-words" tone="attention" title={`Delete ${selected.latest.content.name}?`}><p>Delete this project skill and its history?</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="destructive" disabled={actionDisabled("delete")} aria-disabled={pending === "delete"} onClick={remove}>{label("delete", "Delete skill", "Deleting skill…")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleteConfirmation(false)}>Keep skill</Button></div>{feedback("delete")}</SkillNotice> : null}
    </div> : null}
  </section>;
}
