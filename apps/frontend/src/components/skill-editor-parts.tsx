"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { PersonalSkillContent, PersonalSkillRevision, PersonalSkillSource } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Personal and project skills share the same instruction-only draft form.
export type SkillEditorState = { kind: "inline"; content: PersonalSkillContent } | { kind: "markdown"; markdown: string };
export const emptySkillContent: PersonalSkillContent = { name: "", description: "", instructions: "" };
export const MAX_SKILL_MARKDOWN = 128000;

/** The 3px Signal Teal ring for elements that get focus from code or that scroll. */
export const skillFocusRing = "scroll-my-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
// Prose stays near 70 characters per line.
const measure = "max-w-[70ch]";

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

// Each tone pairs a semantic surface with an icon, so color is never the only cue.
// Text and controls inside stay in ink colors.
const noticeTones = {
  danger: { Icon: CircleAlertIcon, surface: "border-danger/30 bg-danger-surface", icon: "text-danger" },
  attention: { Icon: TriangleAlertIcon, surface: "border-warning/40 bg-warning-surface dark:bg-surface", icon: "text-warning" },
  success: { Icon: CircleCheckIcon, surface: "border-success/30 bg-success-surface", icon: "text-success" }
} as const;

/** A state surface for an error, a decision that needs attention, or a confirmed result. */
export function SkillNotice({ tone, title, children, className = "", ...props }: {
  tone: keyof typeof noticeTones; title: ReactNode; children?: ReactNode;
} & Omit<ComponentProps<"div">, "title">) {
  const { Icon, surface, icon } = noticeTones[tone];
  return <div {...props} className={`flex gap-3 rounded-md border p-3 text-sm text-on-surface sm:p-4 ${surface} ${skillFocusRing} ${className}`}>
    <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${icon}`} />
    <div className="min-w-0 flex-1 space-y-2"><p className="font-semibold">{title}</p>{children}</div>
  </div>;
}

export function SkillSourceFields({ idPrefix, editor, disabled, onChange, onSwitch, onFile, fileMessage }: {
  idPrefix: string;
  editor: SkillEditorState;
  disabled: boolean;
  onChange: (editor: SkillEditorState) => void;
  onSwitch: (kind: SkillEditorState["kind"]) => void;
  onFile: (file?: File) => void;
  /** Shown directly under the file input, for example a file read error. */
  fileMessage?: ReactNode;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return <>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Skill source"><Button size="sm" aria-pressed={editor.kind === "inline"} variant={editor.kind === "inline" ? "secondary" : "outline"} disabled={disabled} onClick={() => onSwitch("inline")}>Write a skill</Button><Button size="sm" aria-pressed={editor.kind === "markdown"} variant={editor.kind === "markdown" ? "secondary" : "outline"} disabled={disabled} onClick={() => onSwitch("markdown")}>Import SKILL.md</Button></div>
    {/* Keys keep React from reusing one source's inputs for the other. */}
    {editor.kind === "inline" ? <div key="inline" className="space-y-4">
      <div><label htmlFor={id("name")} className="text-sm font-medium">Name</label><Input id={id("name")} className="mt-1" value={editor.content.name} maxLength={64} autoComplete="off" placeholder="meeting-notes" disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, name: event.target.value } })} /><p className="mt-1 text-xs text-on-surface-variant">Use lowercase letters, numbers, and hyphens.</p></div>
      {/* A purpose can have 1,024 characters. The field grows to show it and then scrolls. */}
      <div><label htmlFor={id("description")} className="text-sm font-medium">Purpose</label><Textarea id={id("description")} rows={3} className="mt-1 max-h-48 min-h-20" value={editor.content.description} maxLength={1024} disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, description: event.target.value } })} /></div>
      <div><label htmlFor={id("instructions")} className="text-sm font-medium">Instructions</label><Textarea id={id("instructions")} className="mt-1 min-h-48 font-mono" value={editor.content.instructions} maxLength={64000} disabled={disabled} onChange={(event) => onChange({ kind: "inline", content: { ...editor.content, instructions: event.target.value } })} /></div>
    </div> : <div key="markdown" className="space-y-3"><p className="text-sm text-on-surface-variant">Paste one SKILL.md file or upload it. Companion files and folders are not supported.</p><div className="space-y-2"><div><label htmlFor={id("file")} className="text-sm font-medium">Upload SKILL.md</label><Input id={id("file")} className="mt-1" type="file" accept=".md,text/markdown,text/plain" disabled={disabled} onChange={(event) => onFile(event.target.files?.[0])} /></div>{fileMessage}</div><div><label htmlFor={id("markdown")} className="text-sm font-medium">SKILL.md text</label><Textarea id={id("markdown")} className="mt-1 min-h-64 font-mono" value={editor.markdown} maxLength={MAX_SKILL_MARKDOWN} disabled={disabled} onChange={(event) => onChange({ kind: "markdown", markdown: event.target.value })} /></div></div>}
  </>;
}

/** Saved instructions in a bounded well. Keyboard users can focus the well to scroll it. */
export function SkillInstructions({ title, text, inset = true }: { title: string; text: string; inset?: boolean }) {
  const titleId = useId();
  return <div><h4 id={titleId} className="mb-2 text-sm font-semibold">{title}</h4><pre role="region" aria-labelledby={titleId} tabIndex={0} className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md ${inset ? "border border-outline-variant bg-surface p-4" : "p-1"} text-xs leading-relaxed ${measure} ${skillFocusRing}`}>{text}</pre></div>;
}

/**
 * Shows the latest saved revision after a save conflict. The editor keeps the
 * user's text. The user must choose one version before the next save.
 */
export function SkillConflictChoice({ content, disabled, onKeep, onUseLatest, explanation }: {
  content: PersonalSkillContent; disabled: boolean; onKeep: () => void; onUseLatest: () => void; explanation?: string;
}) {
  return <SkillNotice role="group" aria-label="Latest saved version" tone="attention" title="A newer version was saved elsewhere">
    <p className={measure}>{explanation ?? "Compare it with your text, then choose which one to keep."}</p>
    <div><p className="font-medium">{content.name}</p><p className={`whitespace-pre-wrap ${measure}`}>{content.description}</p></div>
    <SkillInstructions title="Latest saved instructions" text={content.instructions} inset={false} />
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={onKeep}>Keep my text</Button><Button size="sm" variant="outline" disabled={disabled} onClick={onUseLatest}>Use the latest version</Button></div>
  </SkillNotice>;
}

export function SkillValidation({ messages }: { messages: string[] }) {
  return <div className="space-y-2"><h4 className="text-sm font-semibold">Validation</h4>{messages.length ? <ul className={`list-disc space-y-1 pl-5 text-sm text-on-surface-variant ${measure}`}>{messages.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="text-sm text-on-surface-variant">No validation warnings.</p>}</div>;
}

/**
 * Lists saved revisions, newest first, in a bounded list that scrolls. `markers`
 * names the role of a revision, such as the one in use. `note` adds a short
 * fact after the date.
 */
export function SkillHistory<Revision extends PersonalSkillRevision>({ revisions, note, markers, id }: {
  revisions: Revision[];
  note?: (revision: Revision) => string | null;
  markers?: (revision: Revision) => string[];
  id?: string;
}) {
  const headingId = useId();
  return <div id={id} className="space-y-2">
    <h4 id={headingId} className="text-sm font-semibold">Revision history</h4>
    <p className="text-xs text-on-surface-variant">{revisions.length === 1 ? "1 saved revision" : `${revisions.length} saved revisions`}, newest first. Up to 50 are shown. The active revision stays in history.</p>
    <div role="region" aria-labelledby={headingId} tabIndex={0} className={`max-h-[min(28rem,55dvh)] overflow-y-auto rounded-md border border-outline-variant ${skillFocusRing}`}>
      <ul className="divide-y divide-outline-variant">{revisions.map((revision) => {
        const roles = markers?.(revision) ?? [];
        const extra = note?.(revision);
        return <li key={revision.revision} className="p-3 text-sm"><details className="group/revision">
          <summary className={`relative cursor-pointer list-none rounded-sm pl-6 [&::-webkit-details-marker]:hidden ${skillFocusRing}`}>
            <ChevronRightIcon aria-hidden="true" className="absolute left-0 top-0.5 size-4 transition-transform group-open/revision:rotate-90 motion-reduce:transition-none" />
            <span className="font-medium">Revision {revision.revision}</span>
            {roles.map((role) => <span key={role} className="ml-2 rounded-sm bg-surface-container px-1.5 py-0.5 text-xs font-medium text-on-surface">{role}</span>)}
            <span className="mt-0.5 block text-xs text-on-surface-variant">{revision.content.name} · {new Date(revision.createdAt).toLocaleString()}{extra ? ` · ${extra}` : ""}</span>
          </summary>
          <div className={`mt-2 space-y-2 ${measure}`}><p className="whitespace-pre-wrap text-on-surface-variant">{revision.content.description}</p><pre className="whitespace-pre-wrap break-words text-xs">{revision.content.instructions}</pre>{revision.validationMessages.length ? <ul className="list-disc pl-5 text-on-surface-variant">{revision.validationMessages.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}</div>
        </details></li>;
      })}</ul>
    </div>
  </div>;
}
