"use client";

import { useEffect, useRef, useState } from "react";

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
  getRevisionGithubMetadata
} from "./admin-skill-card-utils";
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
};

type FilePreview = { skillId: string; skillRevisionId: number; path: string };

export function AdminSkillCard(props: {
  skills: AdminSkill[];
  marketplace: SkillMarketplaceCatalog | null;
  manifestUrl: string | null;
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
}) {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [importedSkill, setImportedSkill] = useState<AdminSkill | null>(null);
  const [reviewTarget, setReviewTarget] = useState<number | null>(null);
  const [quickTarget, setQuickTarget] = useState<{ skillId: string; audience: "off" | "test-users" | "members" } | null>(null);

  async function showImported(result: SkillImportResponse): Promise<void> {
    setImportedSkill(result.skill);
    setReviewTarget(result.revision.skillRevisionId);
    await revisions.open(result.skill.skillId);
  }

  const imports = useSkillImports({
    manifestUrl: props.manifestUrl,
    onImportZip: props.onImportZip,
    onImportGithub: props.onImportGithub,
    onImportInline: props.onImportInline,
    onImported: (result) => { void showImported(result); },
    onSaveManifestUrl: props.onSaveManifestUrl
  });

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
    // Open the history only when no other history is open. Closing another
    // skill would discard its unsaved review notes.
    if (expandedSkillId === null) void openRevisions(targetSkillId);
  }, [targetSkillId, targetExists, expandedSkillId, openRevisions]);

  async function handleEditSubmit(input: {
    skillName: string;
    description: string;
    instructions: string;
  }): Promise<void> {
    if (!editTarget) return;
    try {
      const imported = await props.onImportInline({
        skillId: editTarget.skillId,
        skillName: input.skillName,
        description: input.description,
        instructions: input.instructions
      });
      await showImported(imported);
      setEditTarget(null);
    } catch {
      return;
    }
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
            <p className={SECTION_LABEL}>Skills registry</p>
            <h2 className="text-lg font-semibold text-on-surface">Review and release skills</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Add a skill, review its instructions and permissions, then choose who can use it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={PILL}>{props.skills.length} total</span>
            <span className={PILL}>{props.skills.filter((skill) => skill.enabled).length} enabled</span>
            <Button type="button" onClick={imports.panel.toggle}>
              {imports.panel.open ? "Cancel" : "Add skill"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {imports.panel.open && (
          <Tabs
            value={imports.panel.tab}
            onValueChange={(v) => imports.panel.setTab(v as typeof imports.panel.tab)}
            className="rounded-lg border border-outline-variant bg-surface-container-low p-4"
          >
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
              <TabsTrigger value="zip">ZIP upload</TabsTrigger>
              <TabsTrigger value="inline">Paste SKILL.md</TabsTrigger>
            </TabsList>
            <TabsContent value="marketplace" className="data-[state=inactive]:hidden">
              <AdminSkillMarketplaceTab
                busyKey={props.busyKey}
                manifestUrl={props.manifestUrl}
                manifestUrlDraft={imports.marketplace.manifestUrlDraft}
                marketplace={props.marketplace}
                onClearManifestUrl={() => void imports.marketplace.clearManifestUrl()}
                onImportMarketplace={async (entry) => { await showImported(await props.onImportMarketplace(entry)); }}
                onManifestUrlDraftChange={imports.marketplace.setManifestUrlDraft}
                onSaveManifestUrl={(event) => void imports.marketplace.saveManifestUrl(event)}
              />
            </TabsContent>
            <TabsContent value="github" className="data-[state=inactive]:hidden">
              <AdminSkillGithubImportTab
                busyKey={props.busyKey}
                draft={imports.github.draft}
                onDraftChange={imports.github.setDraft}
                onSubmit={(event) => void imports.github.submit(event)}
              />
            </TabsContent>
            <TabsContent value="zip" className="data-[state=inactive]:hidden">
              <AdminSkillZipUploadTab
                busyKey={props.busyKey}
                zipFileName={imports.zip.zipFileName}
                onZipFileNameChange={imports.zip.setZipFileName}
                onSubmit={(event) => void imports.zip.submit(event)}
              />
            </TabsContent>
            <TabsContent value="inline" className="data-[state=inactive]:hidden">
              <AdminSkillInlineTab
                busyKey={props.busyKey}
                draft={imports.inline.draft}
                onDraftChange={imports.inline.setDraft}
                onSubmit={(event) => void imports.inline.submit(event)}
              />
            </TabsContent>
          </Tabs>
        )}

        <div className="flex flex-col gap-4">
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
                className={`flex scroll-mt-6 flex-col gap-4 rounded-lg border p-4 outline-none sm:flex-row sm:flex-wrap ${isTarget ? "border-primary bg-surface-container-lowest ring-2 ring-primary/30" : "border-outline-variant bg-surface-container-lowest"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-base font-semibold text-on-surface">{skill.skillName}</strong>
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

                  {revisions.loadError[skill.skillId] ? (
                    <p className="mt-2 text-sm text-danger">{revisions.loadError[skill.skillId]}</p>
                  ) : null}

                  {isExpanded ? (
                    <div className="mt-4 flex flex-col gap-3">
                      {skillRevisions.length ? (
                        skillRevisions.map((revision) => (
                          <RevisionRow
                            key={revision.skillRevisionId}
                            skill={skill}
                            revision={revision}
                            busyKey={props.busyKey}
                            onRelease={async (audience, notes, snapshot) => {
                              await props.onActivateRevision({
                                skillId: skill.skillId,
                                skillRevisionId: revision.skillRevisionId,
                                reviewNotes: notes,
                                audience, expectedSnapshot: snapshot
                              });
                              await revisions.refresh(skill.skillId);
                              setReviewTarget(null);
                            }}
                            isReviewTarget={reviewTarget === revision.skillRevisionId}
                            onSaveDraft={() => {
                              setReviewTarget(null);
                              void revisions.toggle(skill.skillId);
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
                        <p className="text-sm text-on-surface-variant">No imported revisions yet.</p>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void revisions.toggle(skill.skillId)}
                  >
                    {isExpanded ? "Hide history" : "Review and history"}
                  </Button>
                  {!skill.isInherited && skill.enabled ? <Button type="button" variant="outline" onClick={() => setQuickTarget({ skillId: skill.skillId, audience: skill.isPublished ? "test-users" : "members" })}>{skill.isPublished ? "Limit to test users" : "Make available to members"}</Button> : null}
                  {!skill.isInherited && (skill.enabled ? <Button type="button" variant="outline" onClick={() => setQuickTarget({ skillId: skill.skillId, audience: "off" })}>Disable</Button> : (
                    skill.activeRevisionId ? <Button type="button" variant="outline" onClick={() => void revisions.open(skill.skillId)}>Re-enable</Button> : null
                  ))}
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

      {filePreview ? (
        <AdminSkillFileModal
          skillId={filePreview.skillId}
          skillRevisionId={filePreview.skillRevisionId}
          path={filePreview.path}
          onClose={() => setFilePreview(null)}
        />
      ) : null}

      {editTarget ? (
        <AdminSkillEditModal
          skillId={editTarget.skillId}
          initialSkillName={editTarget.skillName}
          initialDescription={editTarget.description}
          initialInstructions={editTarget.instructions}
          isBusy={props.busyKey === "skill-import-inline"}
          onCancel={() => setEditTarget(null)}
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
  onSaveDraft: () => void;
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
  const [reviewNotes, setReviewNotes] = useState<string>(revision.reviewNotes ?? "");
  const [audience, setAudience] = useState<"test-users" | "members" | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const instructions = typeof revision.metadata?.instructions === "string" ? revision.metadata.instructions : "";
  const visibleFiles = filesExpanded ? files : files.slice(0, FILE_LIST_COLLAPSED_LIMIT);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className="rounded-md border border-outline-variant bg-surface-container-low p-3">
      {props.isReviewTarget ? <p className="mb-2 text-sm font-medium text-on-surface">Review this new draft before release.</p> : null}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm font-semibold text-on-surface">{formatRevisionLabel(revision)}</strong>
        <span className={CHIP}>{revision.reviewStatus}</span>
        <span className={CHIP}>{revision.validationStatus}</span>
        {revision.bundleName ? <span className={CHIP}>{revision.bundleName}</span> : null}
      </div>
      <p className="text-xs text-on-surface-variant">{revision.sourceLabel ?? "No source label"}</p>

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
            {revision.sourceType === "github" ? "Public GitHub import" : "ZIP upload"}
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
                <code className="font-mono text-xs text-on-surface-variant">{file.path}</code>
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
      <p className="mt-3 text-xs text-on-surface-faint">Skill ID: {skill.skillId}. Revision #{revision.skillRevisionId}. Used in {skill.invokedSessions30d ?? 0} sessions and offered in {skill.materializedSessions30d ?? 0} sessions in the last 30 days.</p>
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
            onChange={(event) => setReviewNotes(event.target.value)}
          />
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
              {!isActive ? <Button type="button" variant="outline" size="sm" onClick={props.onSaveDraft}>Save as draft</Button> : null}
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
