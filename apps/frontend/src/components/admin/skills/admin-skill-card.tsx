"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { getAdminSkillSubmission } from "@/lib/organization-skill-submissions-api";
import { verifyAcceptedSkillDraft, type AcceptedSkillDraft } from "./accepted-skill-draft";
import { AdminSkillEditModal } from "./admin-skill-edit-modal";
import { AdminSkillFileModal } from "./admin-skill-file-modal";
import { AdminSkillGithubImportTab } from "./admin-skill-github-import-tab";
import { AdminSkillInlineTab } from "./admin-skill-inline-tab";
import { AdminSkillMarketplaceTab } from "./admin-skill-marketplace-tab";
import { AdminSkillZipUploadTab } from "./admin-skill-zip-upload-tab";
import { ReleaseImpactStep } from "./release-impact-step";
import { previewAdminSkillRelease } from "@/lib/admin-api";
import {
  FILE_LIST_COLLAPSED_LIMIT,
  formatBytes,
  formatRevisionLabel,
  getRevisionAllowedTools,
  getRevisionFiles,
  getRevisionGithubMetadata,
  describeRevisionSource,
  describeSkillUsage
} from "./admin-skill-card-utils";
import type { SkillReadState } from "../../../hooks/use-admin-skills-data";
import { useSkillImports } from "../../../hooks/use-skill-imports";
import { useSkillRevisions } from "../../../hooks/use-skill-revisions";
import type {
  AdminSkill,
  AdminSkillReleaseSnapshot,
  SkillImportResponse,
  SkillMarketplaceCatalog,
  SkillMarketplaceEntry,
  SkillRevision
} from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CHIP, SECTION_LABEL } from "../../../lib/ui-tokens";

const PILL = "inline-flex items-center rounded-full bg-primary-container px-2 py-0.5 text-xs font-medium text-on-primary-container";

type EditTarget = {
  skillId: string;
  skillName: string;
  description: string;
  instructions: string;
  acceptedDraft?: AcceptedSkillDraft;
  revisionNumber?: number;
};

type FilePreview = { skillId: string; skillRevisionId: number; path: string };
type ReviewNoteDraft = {
  skillId: string;
  revisionId: number;
  revisionNumber: number;
  skillName: string;
  value: string;
};

export function AdminSkillCard(props: {
  skills: AdminSkill[];
  marketplace: SkillMarketplaceCatalog | null;
  manifestUrl: string | null | undefined;
  libraryState?: SkillReadState;
  catalogState?: SkillReadState;
  manifestState?: SkillReadState;
  busyKey: string | null;
  onDisable: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => Promise<AdminSkill>;
  onPublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => Promise<AdminSkill>;
  onUnpublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => Promise<AdminSkill>;
  onImportZip: (file: File) => Promise<SkillImportResponse>;
  onImportGithub: (input: { githubUrl: string; ref?: string; subdirectory?: string }) => Promise<SkillImportResponse>;
  onImportInline: (input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
  }) => Promise<SkillImportResponse>;
  onImportMarketplace: (entry: SkillMarketplaceEntry) => Promise<SkillImportResponse>;
  onListRevisions: (skillId: string) => Promise<SkillRevision[]>;
  onActivateRevision: (input: {
    skillId: string;
    skillRevisionId: number;
    reviewNotes?: string | null;
    audience?: "test-users" | "members";
    expectedSnapshot: AdminSkillReleaseSnapshot;
  }) => Promise<void>;
  onSaveManifestUrl: (url: string | null) => Promise<void>;
  /** A skill to bring into view, for example from quick jump. */
  targetSkillId?: string | null;
  acceptedDraft?: AcceptedSkillDraft | null;
}) {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [handoffState, setHandoffState] = useState<{ draft: AcceptedSkillDraft; status: "loading" | "opened" | "error"; error?: string } | null>(null);
  const [handoffRetry, setHandoffRetry] = useState(0);
  const handledDraft = useRef<AcceptedSkillDraft | null>(null);
  const requestedDraft = useRef(props.acceptedDraft);
  useLayoutEffect(() => { requestedDraft.current = props.acceptedDraft; }, [props.acceptedDraft]);
  const ownerGeneration = useRef(0);
  useLayoutEffect(() => () => { ownerGeneration.current++; }, []);
  const listAcceptedRevisions = useRef(props.onListRevisions);
  useEffect(() => { listAcceptedRevisions.current = props.onListRevisions; }, [props.onListRevisions]);
  const receiptRef = useRef<HTMLDivElement | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [savedImport, setSavedImport] = useState<SkillImportResponse | null>(null);
  const editPending = useRef(false);
  const [importedSkill, setImportedSkill] = useState<AdminSkill | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, ReviewNoteDraft>>({});
  const historyButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const discardReturnSkill = useRef<string | null>(null);
  const [discardKey, setDiscardKey] = useState<string | null>(null);
  const hasUnsentNotes = Object.keys(noteDrafts).length > 0;
  useEffect(() => {
    if (!hasUnsentNotes) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsentNotes]);

  function clearNotes(key: string, expectedValue?: string): void {
    setNoteDrafts(current => {
      if (expectedValue !== undefined && current[key]?.value !== expectedValue) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  const [reviewTarget, setReviewTarget] = useState<number | null>(null);
  const [quickTarget, setQuickTarget] = useState<{ skillId: string; audience: "off" | "test-users" | "members" } | null>(null);

  async function showImported(result: SkillImportResponse): Promise<void> {
    setImportedSkill(result.skill);
    setReviewTarget(result.revision.skillRevisionId);
    await revisions.open(result.skill.skillId);
    requestAnimationFrame(() => document.getElementById(`skill-history-${encodeURIComponent(result.skill.skillId)}`)?.focus());
  }

  const imports = useSkillImports({
    manifestUrl: props.manifestUrl,
    busyKey: props.busyKey,
    onImportZip: props.onImportZip,
    onImportGithub: props.onImportGithub,
    onImportInline: props.onImportInline,
    onImportMarketplace: props.onImportMarketplace,
    onImported: setSavedImport,
    onSaveManifestUrl: props.onSaveManifestUrl
  });

  const importBusyKey = props.busyKey ?? imports.busyKey;

  const revisions = useSkillRevisions({
    onListRevisions: props.onListRevisions
  });

  const targetSkillId = props.targetSkillId ?? null;
  const targetExists = targetSkillId !== null && props.skills.some((skill) => skill.skillId === targetSkillId);
  const targetCardRef = useRef<HTMLDivElement | null>(null);
  const shownTarget = useRef<string | null>(null);
  const { expandedSkillId, open: openRevisions } = revisions;
  useEffect(() => {
    if (!targetSkillId) {
      shownTarget.current = null;
      return;
    }
    if (!targetExists || shownTarget.current === targetSkillId) return;
    shownTarget.current = targetSkillId;
    targetCardRef.current?.scrollIntoView?.({ block: "start" });
    targetCardRef.current?.focus({ preventScroll: true });
    // Keep the current review selected when a quick-jump target arrives.
    if (expandedSkillId === null) void openRevisions(targetSkillId);
  }, [targetSkillId, targetExists, expandedSkillId, openRevisions]);

  useEffect(() => {
    const draft = props.acceptedDraft;
    if (!draft || editTarget || handledDraft.current === draft) return;
    let current = true;
    let settled = false;
    handledDraft.current = draft;
    setHandoffState({ draft, status: "loading" });
    receiptRef.current?.focus();
    Promise.all([getAdminSkillSubmission(draft.submissionId), listAcceptedRevisions.current(draft.skillId)]).then(([response, rows]) => {
      if (!current) return;
      const revision = verifyAcceptedSkillDraft(draft, response, rows);
      settled = true;
      setHandoffState({ draft, status: "opened" });
      setEditTarget({ skillId: draft.skillId, skillName: draft.content.name, description: draft.content.description,
        instructions: draft.content.instructions, acceptedDraft: draft, revisionNumber: revision.revisionNumber });
    }).catch((cause: unknown) => {
      settled = true;
      if (current) setHandoffState({ draft, status: "error", error: cause instanceof Error ? cause.message : "Could not load this accepted draft. Try again." });
    });
    return () => { current = false; if (!settled && handledDraft.current === draft) handledDraft.current = null; };
  }, [props.acceptedDraft, editTarget, handoffRetry]);

  async function handleEditSubmit(input: {
    skillName: string;
    description: string;
    instructions: string;
  }): Promise<void> {
    if (!editTarget || editPending.current) return;
    const target = editTarget;
    const generation = ownerGeneration.current;
    editPending.current = true;
    try {
      if (target.acceptedDraft) {
        const draft = target.acceptedDraft;
        const [response, rows] = await Promise.all([getAdminSkillSubmission(draft.submissionId), props.onListRevisions(draft.skillId)]);
        if (ownerGeneration.current !== generation) return;
        verifyAcceptedSkillDraft(draft, response, rows);
        if (requestedDraft.current !== draft) throw new Error("The selected submission changed. Keep these edits, or close this editor and open the selected draft.");
      }
      const imported = await props.onImportInline({
        skillId: target.skillId,
        skillName: input.skillName,
        description: input.description,
        instructions: input.instructions
      });
      if (ownerGeneration.current !== generation) return;
      setSavedImport(imported);
      setEditTarget(current => current === target ? null : current);
    } finally { editPending.current = false; }
  }

  function openEditModal(skillId: string, revision: SkillRevision): void {
    const metadata = revision.metadata ?? {};
    setEditTarget({
      skillId,
      skillName: typeof metadata.skillName === "string" ? metadata.skillName : "",
      description: typeof metadata.description === "string" ? metadata.description : "",
      instructions: typeof metadata.instructions === "string" ? metadata.instructions : ""
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-on-surface">Review and release skills</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Add a skill, review its instructions and permissions, then choose who can use it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(!props.libraryState || ["empty", "ready", "stale"].includes(props.libraryState.status)) ? <>
            <span className={PILL}>{props.skills.length} total</span>
            <span className={PILL}>{props.skills.filter((skill) => skill.enabled).length} enabled</span>
            </> : null}
            <Button type="button" onClick={imports.panel.toggle}>
              {imports.panel.open ? "Close import" : "Add skill"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {props.acceptedDraft ? <div ref={receiptRef} tabIndex={-1} className="min-w-0 space-y-2 bg-info-surface p-3 text-sm">
          <p className="break-words">Selected {props.acceptedDraft.content.name}, draft revision #{props.acceptedDraft.draftRevisionId}. Accepted revision #{props.acceptedDraft.acceptedRevisionId} stays in submission history. Saving creates the next revision.</p>
          {editTarget && editTarget.acceptedDraft !== props.acceptedDraft ? <p role="status">Finish or cancel the open editor first. Your current edits are kept.</p> : null}
          {handoffState?.draft === props.acceptedDraft && handoffState.status === "loading" ? <p role="status">Loading the exact accepted draft…</p> : null}
          {handoffState?.draft === props.acceptedDraft && handoffState.status === "error" ? <p role="alert" className="text-danger">{handoffState.error}</p> : null}
          {!editTarget && handoffState?.status !== "loading" ? <Button variant="outline" size="sm" onClick={() => { handledDraft.current = null; setHandoffRetry(value => value + 1); }}>Open accepted draft</Button> : null}
        </div> : null}
        {savedImport ? <div className="flex flex-col items-start gap-3 bg-success-surface p-3 text-sm text-success sm:flex-row sm:items-center">
          <p role="status" className="min-w-0 break-words sm:flex-1">Saved {savedImport.skill.skillName}, r{savedImport.revision.revisionNumber}, revision #{savedImport.revision.skillRevisionId}. It is ready for review. Availability has not changed.</p>
          <Button type="button" variant="outline" onClick={() => { void showImported(savedImport); }}>Review saved draft</Button>
        </div> : null}

        <div hidden={!imports.panel.open}>
          {importBusyKey ? <p role="status" className="mb-3 text-sm text-on-surface-variant">A skill operation is pending. Wait before saving or importing again. You can keep editing these drafts.</p> : null}
          <Tabs
            value={imports.panel.tab}
            onValueChange={(v) => imports.panel.setTab(v as typeof imports.panel.tab)}
            className="min-w-0 bg-surface-container-low p-3 sm:p-4"
          >
            <p className="text-sm text-on-surface-variant">Import saves a draft. Review it before you choose who can use it.</p>
            <TabsList aria-label="Import source" className="grid w-full grid-cols-2 sm:grid-cols-4">
              <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
              <TabsTrigger value="zip">ZIP upload</TabsTrigger>
              <TabsTrigger value="inline">Paste SKILL.md</TabsTrigger>
            </TabsList>
            <TabsContent value="marketplace" forceMount className="data-[state=inactive]:hidden">
              <AdminSkillMarketplaceTab
                busyKey={importBusyKey}
                catalogState={props.catalogState}
                manifestState={props.manifestState}
                manifestChanged={imports.marketplace.changedSavedUrl}
                error={imports.errors.marketplace}
                manifestError={imports.errors.manifest}
                manifestUrl={props.manifestUrl}
                manifestUrlDraft={imports.marketplace.manifestUrlDraft}
                marketplace={props.marketplace}
                onClearManifestUrl={() => void imports.marketplace.clearManifestUrl()}
                onImportMarketplace={imports.marketplace.importEntry}
                onManifestUrlDraftChange={imports.marketplace.setManifestUrlDraft}
                onSaveManifestUrl={(event) => void imports.marketplace.saveManifestUrl(event)}
              />
            </TabsContent>
            <TabsContent value="github" forceMount className="data-[state=inactive]:hidden">
              <AdminSkillGithubImportTab
                error={imports.errors.github}
                busyKey={importBusyKey}
                draft={imports.github.draft}
                onDraftChange={imports.github.setDraft}
                onSubmit={(event) => void imports.github.submit(event)}
              />
            </TabsContent>
            <TabsContent value="zip" forceMount className="data-[state=inactive]:hidden">
              <AdminSkillZipUploadTab
                error={imports.errors.zip}
                busyKey={importBusyKey}
                zipFileName={imports.zip.zipFileName}
                onZipFileNameChange={imports.zip.setZipFileName}
                onSubmit={(event) => void imports.zip.submit(event)}
              />
            </TabsContent>
            <TabsContent value="inline" forceMount className="data-[state=inactive]:hidden">
              <AdminSkillInlineTab
                error={imports.errors.inline}
                busyKey={importBusyKey}
                draft={imports.inline.draft}
                onDraftChange={imports.inline.setDraft}
                onSubmit={(event) => void imports.inline.submit(event)}
              />
            </TabsContent>
          </Tabs>
          <p className="mt-3 text-xs text-on-surface-variant">Drafts stay here when you close or switch import tabs. Leaving the library loses unsaved changes.</p>
        </div>



        {props.libraryState ? <div aria-busy={props.libraryState.refreshing} className="flex flex-wrap items-center gap-3 text-sm text-on-surface-variant">
          {props.libraryState.status === "pending" ? <p role="status">Loading skill library...</p> : null}
          {props.libraryState.status === "empty" ? <p>No skills have been saved yet. Add a skill to start a review.</p> : null}
          {["failed", "unavailable", "stale"].includes(props.libraryState.status) ? <p role="alert">{props.libraryState.error ?? "Skill library unavailable."}{props.libraryState.status === "stale" ? " Showing the last loaded library." : ""}</p> : null}
          <Button type="button" variant="outline" size="sm" disabled={props.libraryState.refreshing} onClick={props.libraryState.retry}>{props.libraryState.refreshing ? "Loading library..." : ["failed", "unavailable", "stale"].includes(props.libraryState.status) ? "Retry library" : "Refresh library"}</Button>
        </div> : null}

        {hasUnsentNotes ? <div role="status" className="space-y-2 bg-warning-surface p-3 text-sm text-warning">
          <p>Unsent release notes stay here when you close or switch history. Leaving the library loses these notes.</p>
          <ul className="space-y-1">{Object.entries(noteDrafts).map(([key, draft]) => <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words">{draft.skillName}, r{draft.revisionNumber}, revision #{draft.revisionId}</span>
            <Button type="button" variant="outline" size="sm" aria-label={`Discard unsent notes for ${draft.skillName}, revision #${draft.revisionId}`} onClick={() => { discardReturnSkill.current = draft.skillId; setDiscardKey(key); }}>Discard unsent notes</Button>
          </li>)}</ul>
        </div> : null}
        <div className="flex flex-col divide-y divide-outline-variant">
          {(importedSkill && !props.skills.some((skill) => skill.skillId === importedSkill.skillId)
            ? [importedSkill, ...props.skills]
            : props.skills).map((skill) => {
            const skillRevisions = revisions.revisionMap[skill.skillId] ?? [];
            const isExpanded = revisions.expandedSkillId === skill.skillId;
            const isTarget = skill.skillId === targetSkillId;
            return (
              <div
                key={skill.skillId}
                ref={isTarget ? targetCardRef : undefined}
                tabIndex={isTarget ? -1 : undefined}
                aria-current={isTarget ? "true" : undefined}
                className={`flex min-w-0 scroll-mt-6 flex-col gap-4 py-5 outline-none sm:flex-row sm:flex-wrap ${isTarget ? "rounded-md bg-surface-container-low ring-2 ring-primary/30 px-3" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="break-words text-base font-semibold text-on-surface">{skill.skillName}</strong>
                    {isTarget ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Selected</span> : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        skill.enabled
                          ? "bg-success-surface text-success"
                          : "bg-surface-container text-on-surface-variant"
                      }`}
                    >
                      {skill.enabled
                        ? skill.isPublished ? "Available to members" : "Available to test users"
                        : skill.activeRevisionId ? "Off" : "Awaiting review"}
                    </span>
                    {!skill.isInherited && skill.pendingRevisionCount ? <span className={CHIP}>{skill.pendingRevisionCount} update{skill.pendingRevisionCount === 1 ? "" : "s"} to review</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-on-surface-variant">{skill.description ?? "No description"}</p>
                  {skill.isInherited ? (
                    <p className="mt-2 text-sm text-on-surface-variant">Managed by the platform. You can inspect its history here; availability and revisions are controlled by the platform.</p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    ref={button => { historyButtons.current[skill.skillId] = button; }}
                    aria-expanded={isExpanded}
                    aria-controls={`skill-history-${encodeURIComponent(skill.skillId)}`}
                    onClick={() => void revisions.toggle(skill.skillId)}
                  >
                    {isExpanded ? "Hide history" : "Review and history"}
                  </Button>
                  {!skill.isInherited && skill.enabled ? <Button type="button" variant="outline" onClick={() => setQuickTarget({ skillId: skill.skillId, audience: skill.isPublished ? "test-users" : "members" })}>{skill.isPublished ? "Limit to test users" : "Make available to members"}</Button> : null}
                  {!skill.isInherited && (skill.enabled ? <Button type="button" variant="outline" onClick={() => setQuickTarget({ skillId: skill.skillId, audience: "off" })}>Disable</Button> : (
                    skill.activeRevisionId ? <Button type="button" variant="outline" onClick={() => void revisions.open(skill.skillId)}>Re-enable</Button> : null
                  ))}
                </div>
                <div className="w-full min-w-0" id={`skill-history-${encodeURIComponent(skill.skillId)}`} tabIndex={-1} hidden={!isExpanded} aria-busy={Boolean(revisions.loading[skill.skillId])}>
                  {isExpanded ? (
                    <div className="mt-4 flex min-w-0 flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <h3 className="text-sm font-semibold">History for {skill.skillName}</h3>
                        <Button type="button" variant="outline" size="sm" disabled={Boolean(revisions.loading[skill.skillId])} onClick={() => void revisions.refresh(skill.skillId).catch(() => {})}>
                          {revisions.loading[skill.skillId] ? "Loading history…" : revisions.loadError[skill.skillId] ? "Retry history" : "Refresh history"}
                        </Button>
                      </div>
                      {revisions.loading[skill.skillId] ? <p role="status" className="text-sm text-on-surface-variant">Loading history for {skill.skillName}…</p> : null}
                      {revisions.loadError[skill.skillId] ? <p role="alert" className="text-sm text-danger">Could not load history for {skill.skillName}. {revisions.loadError[skill.skillId]}{skillRevisions.length ? " Showing the last loaded revisions." : ""}</p> : null}
                      {skillRevisions.length ? (
                        skillRevisions.map((revision) => (
                          <RevisionRow
                            key={revision.skillRevisionId}
                            skill={skill}
                            revision={revision}
                            busyKey={props.busyKey}
                            reviewNotes={noteDrafts[JSON.stringify([skill.skillId, revision.skillRevisionId])]?.value ?? revision.reviewNotes ?? ""}
                            onReviewNotesChange={value => {
                              const key = JSON.stringify([skill.skillId, revision.skillRevisionId]);
                              if (value === (revision.reviewNotes ?? "")) clearNotes(key);
                              else setNoteDrafts(current => ({ ...current, [key]: { skillId: skill.skillId, revisionId: revision.skillRevisionId, revisionNumber: revision.revisionNumber, skillName: skill.skillName, value } }));
                            }}
                            onRelease={async (audience, notes, snapshot) => {
                              const noteKey = JSON.stringify([skill.skillId, revision.skillRevisionId]);
                              const submittedValue = noteDrafts[noteKey]?.value;
                              await props.onActivateRevision({
                                skillId: skill.skillId,
                                skillRevisionId: revision.skillRevisionId,
                                reviewNotes: notes,
                                audience, expectedSnapshot: snapshot
                              });
                              if (submittedValue !== undefined) clearNotes(noteKey, submittedValue);
                              await revisions.refresh(skill.skillId);
                              setReviewTarget(null);
                            }}
                            isReviewTarget={reviewTarget === revision.skillRevisionId}
                            onFinishReview={() => {
                              setReviewTarget(null);
                              void revisions.toggle(skill.skillId);
                              historyButtons.current[skill.skillId]?.focus();
                            }}
                            onPreviewFile={(path) =>
                              setFilePreview({
                                skillId: skill.skillId,
                                skillRevisionId: revision.skillRevisionId,
                                path
                              })
                            }
                            onEdit={() => openEditModal(skill.skillId, revision)}
                          />
                        ))
                      ) : (
                        !revisions.loading[skill.skillId] && !revisions.loadError[skill.skillId] ? <p className="text-sm text-on-surface-variant">No saved revisions yet.</p> : null
                      )}
                    </div>
                  ) : null}
                </div>
                {quickTarget?.skillId === skill.skillId && skill.enabled && !skill.isInherited ? <div className="min-w-0 w-full border-t border-outline-variant pt-4"><ReleaseImpactStep
                  key={`${skill.skillId}:${skill.version}:${quickTarget.audience}`}
                  choiceKey={`${skill.skillId}:${skill.version}:${quickTarget.audience}`}
                  previewLabel={`Preview ${quickTarget.audience === "off" ? "disable" : quickTarget.audience === "test-users" ? "limit to test users" : "availability to members"}`}
                  confirmLabel={`Confirm ${quickTarget.audience === "off" ? "disable" : quickTarget.audience === "test-users" ? "limit to test users" : "availability to members"}`}
                  disabled={props.busyKey !== null}
                  load={() => previewAdminSkillRelease(skill.skillId, { action: "audience", revisionId: skill.activeRevisionId, audience: quickTarget.audience })}
                  confirm={async (snapshot) => {
                    if (quickTarget.audience === "off") await props.onDisable(skill.skillId, snapshot);
                    else if (quickTarget.audience === "test-users") await props.onUnpublish(skill.skillId, snapshot);
                    else await props.onPublish(skill.skillId, snapshot);
                    setQuickTarget(null);
                  }} /></div> : null}
              </div>
            );
          })}
        </div>
      </CardContent>

      <AlertDialog open={discardKey !== null} onOpenChange={open => { if (!open) setDiscardKey(null); }}>
        {/* Keep the confirmation above its overlay after a rapid reopen. */}
        <AlertDialogContent className="z-[51]" onCloseAutoFocus={event => {
          const skillId = discardReturnSkill.current;
          if (skillId) {
            event.preventDefault();
            historyButtons.current[skillId]?.focus();
          }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsent release notes?</AlertDialogTitle>
            <AlertDialogDescription>
              {discardKey && noteDrafts[discardKey] ? `${noteDrafts[discardKey].skillName}, r${noteDrafts[discardKey].revisionNumber}, revision #${noteDrafts[discardKey].revisionId}. Only your unsent notes will be removed. The saved revision and its existing review notes stay unchanged.` : "The saved revision stays unchanged."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { discardReturnSkill.current = null; }}>Keep notes</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { if (discardKey) clearNotes(discardKey); setDiscardKey(null); }}>Discard notes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {filePreview ? (
        <AdminSkillFileModal
          skillId={filePreview.skillId}
          skillRevisionId={filePreview.skillRevisionId}
          path={filePreview.path}
          onClose={() => setFilePreview(null)}
        />
      ) : null}

      {editTarget?.acceptedDraft ? <p role="status" className="sr-only">Editor seeded from draft r{editTarget.revisionNumber}, revision #{editTarget.acceptedDraft.draftRevisionId}, accepted revision #{editTarget.acceptedDraft.acceptedRevisionId}.</p> : null}
      {editTarget ? (
        <AdminSkillEditModal
          key={editTarget.skillId}
          skillId={editTarget.skillId}
          initialSkillName={editTarget.skillName}
          initialDescription={editTarget.description}
          initialInstructions={editTarget.instructions}
          sourceDescription={editTarget.acceptedDraft ? `Editing draft r${editTarget.revisionNumber}, revision #${editTarget.acceptedDraft.draftRevisionId}. Accepted revision #${editTarget.acceptedDraft.acceptedRevisionId} stays in submission history. Saving creates a new revision.` : undefined}
          isBusy={props.busyKey !== null}
          onCancel={() => { setEditTarget(null); if (editTarget.acceptedDraft) requestAnimationFrame(() => receiptRef.current?.focus()); }}
          onSubmit={handleEditSubmit}
        />
      ) : null}
    </Card>
  );
}

function RevisionRow(props: {
  skill: AdminSkill;
  revision: SkillRevision;
  busyKey: string | null;
  onRelease: (audience: "test-users" | "members", reviewNotes: string | null, snapshot: AdminSkillReleaseSnapshot) => Promise<void>;
  onFinishReview: () => void;
  reviewNotes: string;
  onReviewNotesChange: (value: string) => void;
  isReviewTarget: boolean;
  onPreviewFile: (path: string) => void;
  onEdit: () => void;
}) {
  const { skill, revision } = props;
  const reviewKey = `${skill.skillId}-${revision.skillRevisionId}`;
  const isActive = skill.activeRevisionId === revision.skillRevisionId;
  const github = getRevisionGithubMetadata(revision);
  const files = getRevisionFiles(revision);
  const validationMessages = revision.validationMessages;
  const allowedTools = getRevisionAllowedTools(revision);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const { reviewNotes } = props;
  const [audience, setAudience] = useState<"test-users" | "members" | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const instructions = typeof revision.metadata?.instructions === "string" ? revision.metadata.instructions : "";
  const visibleFiles = filesExpanded ? files : files.slice(0, FILE_LIST_COLLAPSED_LIMIT);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className="min-w-0 space-y-3 border-t border-outline-variant pt-4">
      {props.isReviewTarget ? <p className="mb-2 text-sm font-medium text-on-surface">Review this new draft before release.</p> : null}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm font-semibold text-on-surface">{formatRevisionLabel(revision)}</strong>
        <span className={CHIP}>{revision.reviewStatus}</span>
        <span className={CHIP}>{revision.validationStatus}</span>
        {revision.bundleName ? <span className={CHIP}>{revision.bundleName}</span> : null}
      </div>
      <p className="break-words text-xs text-on-surface-variant">{revision.sourceLabel ?? "No source label"}</p>
      {!isActive ? <p className="text-sm text-on-surface-variant">This revision is already saved. Release notes are sent only when you confirm a release.</p> : null}

      {instructions ? (
        <div className="mt-3">
          <span className={SECTION_LABEL}>Instructions</span>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-container-lowest p-3 text-xs text-on-surface">{instructions}</pre>
        </div>
      ) : null}

      <div className="mt-3">
        <span className={SECTION_LABEL}>Validation and permissions</span>
        <p className="text-sm text-on-surface">{revision.validationStatus}</p>
        {allowedTools.length ? <p className="text-sm text-on-surface-variant">Declared tools: {allowedTools.join(", ")}</p> : <p className="text-sm text-on-surface-variant">No tools declared.</p>}
      </div>

      {validationMessages.length ? (
        <div className="mt-3">
          <span className={SECTION_LABEL}>Validation results</span>
          <ul className="mt-1 list-disc pl-5 text-sm text-on-surface-variant">
            {validationMessages.map((message, index) => (
              <li key={`${revision.skillRevisionId}-validation-${index}`}>
                {String(message.level ?? "Result")}: {String(message.path ?? "SKILL.md")}: {String(message.message ?? "No details")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-on-surface">Technical details and files</summary>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <span className={SECTION_LABEL}>Provenance</span>
          <p className="text-sm text-on-surface">
            {describeRevisionSource(revision)}
          </p>
          {github ? (
            <>
              <p className="text-xs text-on-surface-faint break-all">{github.url}</p>
              <p className="text-xs text-on-surface-faint">
                Ref: {github.ref ?? "default branch"}
                {github.subdirectory ? ` - ${github.subdirectory}` : ""}
              </p>
            </>
          ) : null}
        </div>
        <div>
          <span className={SECTION_LABEL}>Bundle</span>
          <p className="text-sm text-on-surface">{revision.bundleName ?? "Unknown bundle"}</p>
          <p className="text-xs text-on-surface-faint">Hash: {revision.bundleHash.slice(0, 12)}...</p>
          <p className="text-xs text-on-surface-faint">Files: {files.length}</p>
        </div>
        <div>
          <span className={SECTION_LABEL}>Validation</span>
          <p className="text-sm text-on-surface">{revision.validationStatus}</p>
          <p className="text-xs text-on-surface-faint">
            {validationMessages.length
              ? `${validationMessages.length} result${validationMessages.length === 1 ? "" : "s"}`
              : "No issues recorded"}
          </p>
        </div>
      </div>


      {files.length ? (
        <div className="mt-3">
          <span className={SECTION_LABEL}>File inventory</span>
          <div className="mt-1 flex flex-col gap-1">
            {visibleFiles.map((file) => (
              <button
                key={`${revision.skillRevisionId}-${file.path}`}
                type="button"
                onClick={() => props.onPreviewFile(file.path)}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-surface-container"
              >
                <code className="min-w-0 break-all font-mono text-xs text-on-surface-variant">{file.path}</code>
                <span className="text-xs text-on-surface-faint">{formatBytes(file.sizeBytes)}</span>
              </button>
            ))}
          </div>
          {files.length > FILE_LIST_COLLAPSED_LIMIT ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={() => setFilesExpanded((v) => !v)}
            >
              {filesExpanded ? "Show fewer files" : `Show all ${files.length} files`}
            </Button>
          ) : null}
          {!filesExpanded && hiddenCount > 0 ? (
            <p className="mt-1 text-xs text-on-surface-faint">+{hiddenCount} more files hidden</p>
          ) : null}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-on-surface-faint">Skill ID: {skill.skillId}. Revision #{revision.skillRevisionId}. {describeSkillUsage(skill)}</p>
      </details>

      {skill.isInherited ? (
        revision.reviewNotes ? <p className="mt-3 text-sm text-on-surface-variant">Review notes: {revision.reviewNotes}</p> : null
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor={`review-notes-${reviewKey}`}>Review notes</Label>
          <Textarea
            id={`review-notes-${reviewKey}`}
            rows={2}
            value={reviewNotes}
            disabled={releasing}
            aria-describedby={`review-notes-help-${reviewKey}`}
            onChange={(event) => props.onReviewNotesChange(event.target.value)}
          />
          <p id={`review-notes-help-${reviewKey}`} className="text-xs text-on-surface-variant">Notes for r{revision.revisionNumber}, revision #{revision.skillRevisionId}. Kept in this library view until release or explicit discard.</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!skill.isInherited && (!isActive || !skill.enabled || releaseError) ? (
          <div className="w-full space-y-3">
            <fieldset className="space-y-1 text-sm text-on-surface">
              <legend className="font-medium">Who can use this skill?</legend>
              <label className="flex items-center gap-2"><input type="radio" name={`audience-${reviewKey}`} checked={audience === "test-users"} onChange={() => setAudience("test-users")} /> Test users</label>
              <label className="flex items-center gap-2"><input type="radio" name={`audience-${reviewKey}`} checked={audience === "members"} onChange={() => setAudience("members")} /> All members</label>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              {audience ? <ReleaseImpactStep
                key={`${reviewKey}:${skill.version}:${audience}`}
                choiceKey={`${reviewKey}:${skill.version}:${audience}`}
                previewLabel={isActive ? "Preview re-enable" : "Preview release"}
                confirmLabel={isActive ? "Confirm re-enable" : "Confirm release"}
                disabled={releasing || props.busyKey !== null || !["validated", "validated_with_warnings", "active"].includes(revision.validationStatus)}
                load={() => previewAdminSkillRelease(skill.skillId, { action: "activate", revisionId: revision.skillRevisionId, audience })}
                confirm={async (snapshot) => {
                  setReleaseError(null); setReleasing(true);
                  try { await props.onRelease(audience, reviewNotes.trim() || null, snapshot); }
                  catch (error) { setReleaseError(error instanceof Error ? error.message : "Could not release this skill."); throw error; }
                  finally { setReleasing(false); }
                }} /> : <Button type="button" size="sm" disabled>Choose an audience to preview</Button>}
              {!isActive ? <Button type="button" variant="outline" size="sm" disabled={releasing} onClick={props.onFinishReview}>Close review</Button> : null}
            </div>
          </div>
        ) : isActive && skill.enabled ? <span className="text-sm text-success">Active revision</span> : null}
        {isActive && revision.bundleStorageUri === null && !skill.isInherited ? (
          <Button type="button" variant="outline" size="sm" onClick={props.onEdit}>
            Edit
          </Button>
        ) : null}
        {isActive && revision.bundleStorageUri !== null && !skill.isInherited ? (
          <span className="text-xs text-on-surface-variant">Re-upload to update</span>
        ) : null}
        {isActive && revision.bundleStorageUri === null && skill.isInherited ? (
          <span className="text-xs text-on-surface-variant">
            Managed by the platform. Import a copy with a new skill ID to customize it.
          </span>
        ) : null}
      </div>
    </div>
  );
}
