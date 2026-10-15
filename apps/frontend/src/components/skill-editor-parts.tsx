"use client";

import type { PersonalSkillContent, PersonalSkillRevision, PersonalSkillSource } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Personal and project skills share the same instruction-only draft form.
export type SkillEditorState = { kind: "inline"; content: PersonalSkillContent } | { kind: "markdown"; markdown: string };
export const emptySkillContent: PersonalSkillContent = { name: "", description: "", instructions: "" };
export const MAX_SKILL_MARKDOWN = 128000;

export function skillEditorSource(editor: SkillEditorState): PersonalSkillSource {
  return editor.kind === "inline" ? { kind: "inline", ...editor.content } : { kind: "markdown", markdown: editor.markdown };
}

export function skillEditorComplete(editor: SkillEditorState): boolean {
  return editor.kind === "inline"
    ? Boolean(editor.content.name.trim() && editor.content.description.trim() && editor.content.instructions.trim())
    : Boolean(editor.markdown.trim());
}

/** Reads one SKILL.md file. Throws an Error with a message for the member. */
export async function readSkillMarkdownFile(file: File): Promise<string> {
  const tooLarge = "This file is too large. The limit is 128,000 characters.";
  if (!file.name.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown (.md) file.");
  if (file.size > MAX_SKILL_MARKDOWN * 4) throw new Error(tooLarge);
  const markdown = await file.text();
  if (markdown.length > MAX_SKILL_MARKDOWN) throw new Error(tooLarge);
  return markdown;
}

export function SkillSourceFields({ idPrefix, editor, disabled, onChange, onSwitch, onFile }: {
  idPrefix: string;
  editor: SkillEditorState;
  disabled: boolean;
  onChange: (editor: SkillEditorState) => void;
  onSwitch: (kind: SkillEditorState["kind"]) => void;
  onFile: (file?: File) => void;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return <>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Skill source"><Button size="sm" aria-pressed={editor.kind === "inline"} variant={editor.kind === "inline" ? "secondary" : "outline"} disabled={disabled} onClick={() => onSwitch("inline")}>Write a skill</Button><Button size="sm" aria-pressed={editor.kind === "markdown"} variant={editor.kind === "markdown" ? "secondary" : "outline"} disabled={disabled} onClick={() => onSwitch("markdown")}>Import SKILL.md</Button></div>
    {/* Keys keep React from reusing one source's inputs for the other. */}
    {editor.kind === "inline" ? <div key="inline" className="space-y-4">
      <div><label htmlFor={id("name")} className="text-sm font-medium">Name</label><Input id={id("name")} className="mt-1" value={editor.content.name} maxLength={64} autoComplete="off" placeholder="meeting-notes" disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, name: event.target.value } })} /><p className="mt-1 text-xs text-on-surface-variant">Use lowercase letters, numbers, and hyphens.</p></div>
      <div><label htmlFor={id("description")} className="text-sm font-medium">Purpose</label><Input id={id("description")} className="mt-1" value={editor.content.description} maxLength={1024} disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, description: event.target.value } })} /></div>
      <div><label htmlFor={id("instructions")} className="text-sm font-medium">Instructions</label><Textarea id={id("instructions")} className="mt-1 min-h-48 font-mono" value={editor.content.instructions} maxLength={64000} disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, instructions: event.target.value } })} /></div>
    </div> : <div key="markdown" className="space-y-3"><p className="text-sm text-on-surface-variant">Paste one SKILL.md file or upload it. Companion files and folders are not supported.</p><div><label htmlFor={id("file")} className="text-sm font-medium">Upload SKILL.md</label><Input id={id("file")} className="mt-1" type="file" accept=".md,text/markdown,text/plain" disabled={disabled} onChange={(event) => onFile(event.target.files?.[0])} /></div><div><label htmlFor={id("markdown")} className="text-sm font-medium">SKILL.md text</label><Textarea id={id("markdown")} className="mt-1 min-h-64 font-mono" value={editor.markdown} maxLength={MAX_SKILL_MARKDOWN} disabled={disabled} onChange={(event) => onChange({ kind: "markdown", markdown: event.target.value })} /></div></div>}
  </>;
}

export function SkillInstructions({ title, text }: { title: string; text: string }) {
  return <div><h4 className="mb-2 text-sm font-semibold">{title}</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-outline-variant bg-surface p-4 text-xs leading-relaxed">{text}</pre></div>;
}

/**
 * Shows the latest saved revision after a save conflict. The editor keeps the
 * user's text. The user must choose one version before the next save.
 */
export function SkillConflictChoice({ content, disabled, onKeep, onUseLatest }: {
  content: PersonalSkillContent; disabled: boolean; onKeep: () => void; onUseLatest: () => void;
}) {
  return <div role="group" aria-label="Latest saved version" className="space-y-3 rounded-md border border-danger p-4">
    <p className="text-sm">A newer version of this skill was saved elsewhere. Compare it with your text, then choose which one to keep.</p>
    <div><p className="text-sm font-medium">{content.name}</p><p className="text-sm text-on-surface-variant">{content.description}</p></div>
    <SkillInstructions title="Latest saved instructions" text={content.instructions} />
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={onKeep}>Keep my text</Button><Button size="sm" variant="outline" disabled={disabled} onClick={onUseLatest}>Use the latest version</Button></div>
  </div>;
}

export function SkillValidation({ messages }: { messages: string[] }) {
  return <div className="space-y-2"><h4 className="text-sm font-semibold">Validation</h4>{messages.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-on-surface-variant">{messages.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="text-sm text-on-surface-variant">No validation warnings.</p>}</div>;
}

export function SkillHistory<Revision extends PersonalSkillRevision>({ revisions, note }: {
  revisions: Revision[];
  note?: (revision: Revision) => string | null;
}) {
  return <div className="space-y-2"><h4 className="text-sm font-semibold">Revision history</h4><p className="text-xs text-on-surface-variant">Keeps up to 50 revisions, including the version in use.</p><ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">{revisions.map((revision) => <li key={revision.revision} className="p-3 text-sm"><details><summary className="cursor-pointer font-medium">Revision {revision.revision} · {revision.content.name} · {new Date(revision.createdAt).toLocaleString()}{note?.(revision) ? ` · ${note(revision)}` : ""}</summary><p className="mt-2 text-on-surface-variant">{revision.content.description}</p><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{revision.content.instructions}</pre>{revision.validationMessages.length ? <ul className="mt-2 list-disc pl-5 text-on-surface-variant">{revision.validationMessages.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}</details></li>)}</ul></div>;
}
