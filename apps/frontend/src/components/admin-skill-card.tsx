"use client";

import { useState } from "react";

import { AdminSkillEditModal } from "./admin-skill-edit-modal";
import { AdminSkillFileModal } from "./admin-skill-file-modal";
import { AdminSkillGithubImportTab } from "./admin-skill-github-import-tab";
import { AdminSkillInlineTab } from "./admin-skill-inline-tab";
import { AdminSkillMarketplaceTab } from "./admin-skill-marketplace-tab";
import { AdminSkillZipUploadTab } from "./admin-skill-zip-upload-tab";
import {
  describeSkillState,
  FILE_LIST_COLLAPSED_LIMIT,
  formatBytes,
  formatRevisionLabel,
  getRevisionAllowedTools,
  getRevisionFiles,
  getRevisionGithubMetadata
} from "./admin-skill-card-utils";
import { useSkillImports } from "../hooks/use-skill-imports";
import { useSkillRevisions } from "../hooks/use-skill-revisions";
import type {
  AdminSkill,
  SkillMarketplaceCatalog,
  SkillMarketplaceEntry,
  SkillRevision
} from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const SECTION_LABEL = "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const CHIP = "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";
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
  onDisable: (skillId: string) => void;
  onPublish: (skillId: string) => void;
  onUnpublish: (skillId: string) => void;
  onImportZip: (file: File) => Promise<void>;
  onImportGithub: (input: { githubUrl: string; ref?: string; subdirectory?: string }) => Promise<void>;
  onImportInline: (input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
  }) => Promise<void>;
  onImportMarketplace: (entry: SkillMarketplaceEntry) => Promise<void>;
  onListRevisions: (skillId: string) => Promise<SkillRevision[]>;
  onActivateRevision: (input: {
    skillId: string;
    skillRevisionId: number;
    reviewNotes?: string | null;
  }) => Promise<void>;
  onSaveManifestUrl: (url: string | null) => Promise<void>;
}) {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);

  const imports = useSkillImports({
    manifestUrl: props.manifestUrl,
    onImportZip: props.onImportZip,
    onImportGithub: props.onImportGithub,
    onImportInline: props.onImportInline,
    onSaveManifestUrl: props.onSaveManifestUrl
  });

  const revisions = useSkillRevisions({
    onListRevisions: props.onListRevisions,
    onActivateRevision: props.onActivateRevision
  });

  async function handleEditSubmit(input: {
    skillName: string;
    description: string;
    instructions: string;
  }): Promise<void> {
    if (!editTarget) return;
    try {
      await props.onImportInline({
        skillId: editTarget.skillId,
        skillName: input.skillName,
        description: input.description,
        instructions: input.instructions
      });
      await revisions.refresh(editTarget.skillId);
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
            <h2 className="text-lg font-semibold text-on-surface">Bundles, imports, and activation</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Import reviewed AgentSkills bundles, inspect revisions, and explicitly activate what new
              runtimes should receive.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={PILL}>{props.skills.length} total</span>
            <span className={PILL}>{props.skills.filter((skill) => skill.enabled).length} enabled</span>
            <Button type="button" onClick={imports.panel.toggle}>
              {imports.panel.open ? "Cancel" : "Import skill"}
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
                onImportMarketplace={props.onImportMarketplace}
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
          {props.skills.map((skill) => {
            const skillRevisions = revisions.revisionMap[skill.skillId] ?? [];
            const isExpanded = revisions.expandedSkillId === skill.skillId;
            return (
              <div
                key={skill.skillId}
                className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface-container-lowest p-4 sm:flex-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-base font-semibold text-on-surface">{skill.skillName}</strong>
                    <span className={PILL}>v{skill.version}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        skill.enabled
                          ? "bg-success-surface text-success"
                          : "bg-surface-container text-on-surface-faint"
                      }`}
                    >
                      {skill.enabled ? "enabled" : "disabled"}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        skill.isPublished
                          ? "bg-success-surface text-success"
                          : "bg-surface-container text-on-surface-faint"
                      }`}
                    >
                      {skill.isPublished ? "published" : "draft"}
                    </span>
                    {skill.activeSourceType ? <span className={CHIP}>{skill.activeSourceType}</span> : null}
                    <span
                      className={PILL}
                      title="Distinct sessions in the last 30 days where this skill was actually used (tool-call match)."
                    >
                      Used {skill.invokedSessions30d ?? 0}
                    </span>
                    <span
                      className={PILL}
                      title="Distinct sessions in the last 30 days where this skill was offered to the agent (regardless of whether it was used)."
                    >
                      Available {skill.materializedSessions30d ?? 0}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-on-surface-faint">{skill.skillId}</p>
                  <p className="mt-1 text-sm text-on-surface-variant">{skill.description ?? "No description"}</p>
                  <p className="mt-1 text-xs text-on-surface-faint">{describeSkillState(skill)}</p>
                  {skill.activeRevisionId ? (
                    <span className={`${CHIP} mt-2`}>active revision #{skill.activeRevisionId}</span>
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
                            onActivate={(notes) =>
                              void revisions.activate(skill.skillId, revision.skillRevisionId, notes)
                            }
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
                    {isExpanded ? "Hide revisions" : "Review revisions"}
                  </Button>
                  {skill.isPublished ? (
                    <Button type="button" variant="outline" onClick={() => props.onUnpublish(skill.skillId)}>
                      Unpublish
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" onClick={() => props.onPublish(skill.skillId)}>
                      Publish
                    </Button>
                  )}
                  <Button type="button" variant="outline" onClick={() => props.onDisable(skill.skillId)}>
                    Disable
                  </Button>
                </div>
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
  onActivate: (reviewNotes: string | null) => void;
  onPreviewFile: (path: string) => void;
  onEdit: () => void;
}) {
  const { skill, revision } = props;
  const reviewKey = `${skill.skillId}-${revision.skillRevisionId}`;
  const isActive = skill.activeRevisionId === revision.skillRevisionId;
  const github = getRevisionGithubMetadata(revision);
  const files = getRevisionFiles(revision);
  const validationWarnings = revision.validationMessages.filter(
    (message) => String(message.level ?? "") === "warning"
  );
  const allowedTools = getRevisionAllowedTools(revision);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<string>(revision.reviewNotes ?? "");
  const visibleFiles = filesExpanded ? files : files.slice(0, FILE_LIST_COLLAPSED_LIMIT);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className="rounded-md border border-outline-variant bg-surface-container-low p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm font-semibold text-on-surface">{formatRevisionLabel(revision)}</strong>
        <span className={CHIP}>{revision.reviewStatus}</span>
        <span className={CHIP}>{revision.validationStatus}</span>
        {revision.bundleName ? <span className={CHIP}>{revision.bundleName}</span> : null}
      </div>
      <p className="text-xs text-on-surface-faint">{revision.sourceLabel ?? "No source label"}</p>

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
            {validationWarnings.length
              ? `${validationWarnings.length} warning${validationWarnings.length === 1 ? "" : "s"}`
              : "No warnings recorded"}
          </p>
        </div>
      </div>

      {allowedTools.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {allowedTools.map((tool) => (
            <span key={tool} className={CHIP}>{tool}</span>
          ))}
        </div>
      ) : null}

      {validationWarnings.length ? (
        <div className="mt-3">
          <span className={SECTION_LABEL}>Validation warnings</span>
          <ul className="mt-1 list-disc pl-5 text-sm text-on-surface-variant">
            {validationWarnings.map((message, index) => (
              <li key={`${revision.skillRevisionId}-warning-${index}`}>
                {String(message.path ?? "SKILL.md")}: {String(message.message ?? "Warning")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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

      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor={`review-notes-${reviewKey}`}>Review notes</Label>
        <Textarea
          id={`review-notes-${reviewKey}`}
          rows={2}
          value={reviewNotes}
          onChange={(event) => setReviewNotes(event.target.value)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isActive || props.busyKey === `activate-skill-${skill.skillId}-${revision.skillRevisionId}`}
          onClick={() => props.onActivate(reviewNotes.trim() === "" ? null : reviewNotes)}
        >
          {isActive ? "Active" : "Activate revision"}
        </Button>
        {isActive && revision.bundleStorageUri === null && !skill.isInherited ? (
          <Button type="button" variant="outline" size="sm" onClick={props.onEdit}>
            Edit
          </Button>
        ) : null}
        {isActive && revision.bundleStorageUri !== null ? (
          <span className="text-xs text-on-surface-faint">Re-upload to update</span>
        ) : null}
        {isActive && revision.bundleStorageUri === null && skill.isInherited ? (
          <span className="text-xs text-on-surface-faint">
            Inherited from platform — copy to a new skill id to customize
          </span>
        ) : null}
      </div>
    </div>
  );
}
