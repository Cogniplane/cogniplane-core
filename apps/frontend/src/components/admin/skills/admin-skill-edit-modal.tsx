"use client";

import { FormEvent, useId, useRef, useState } from "react";

import { CONFIRM_LEAVE_MESSAGE, useConfirmLeave } from "@/hooks/use-confirm-leave";
import { toErrorMessage } from "@/lib/error-utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  skillId: string;
  initialSkillName: string;
  initialDescription: string;
  initialInstructions: string;
  sourceDescription?: string;
  isBusy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    skillName: string;
    description: string;
    instructions: string;
  }) => Promise<void>;
};

export function AdminSkillEditModal({
  skillId,
  initialSkillName,
  initialDescription,
  initialInstructions,
  sourceDescription,
  isBusy,
  onCancel,
  onSubmit
}: Props) {
  const formId = useId();
  const [skillName, setSkillName] = useState(initialSkillName);
  const [description, setDescription] = useState(initialDescription);
  const [instructions, setInstructions] = useState(initialInstructions);

  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = saving || isBusy;
  const dirty = skillName !== initialSkillName || description !== initialDescription || instructions !== initialInstructions;
  useConfirmLeave(dirty || busy);

  function cancel(): void {
    if (pending.current || isBusy) return;
    if (!dirty || window.confirm(CONFIRM_LEAVE_MESSAGE)) onCancel();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending.current || busy) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try { await onSubmit({
      skillName: skillName.trim(),
      description: description.trim(),
      instructions
    }); } catch (error) { setError(toErrorMessage(error, "Could not save this revision. Your changes are kept.")); }
    finally { pending.current = false; setSaving(false); }
  }

  const submitDisabled =
    busy || !skillName.trim() || !description.trim() || !instructions.trim();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}
        footer={<DialogFooter className="static shrink-0 border-t border-outline-variant pt-3 shadow-none">
          <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={submitDisabled}>
            {busy ? "Saving..." : "Save as new revision"}
          </Button>
        </DialogFooter>}
        onEscapeKeyDown={event => { if (pending.current || isBusy) event.preventDefault(); }}
        onInteractOutside={event => { if (pending.current || isBusy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Edit skill: {skillId}</DialogTitle>
          <DialogDescription>{sourceDescription ?? "Update this skill's metadata and instructions."}</DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={event => { void handleSubmit(event); }} className="flex flex-col gap-4" aria-busy={busy}
          onFocusCapture={event => {
            const field = event.target;
            if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
            const body = field.closest('[data-slot="dialog-body"]');
            if (!body) return;
            const bounds = body.getBoundingClientRect();
            const target = field.getBoundingClientRect();
            if (target.top < bounds.top + 4 || target.bottom > bounds.bottom - 4) field.scrollIntoView?.({ block: "nearest" });
          }}>
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-on-surface-variant">
            Saving creates a new revision. The current active revision stays in place until you
            activate the new one from the revision panel.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-name">Display name</Label>
            <Input
              id="skill-edit-name"
              className="scroll-m-1"
              type="text"
              maxLength={64}
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-description">Description</Label>
            <Input
              id="skill-edit-description"
              className="scroll-m-1"
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-instructions">Instructions (SKILL.md body)</Label>
            <Textarea
              id="skill-edit-instructions"
              rows={10}
              className="max-h-[min(24rem,calc(100dvh-15rem))] scroll-m-1 overflow-y-auto font-mono"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>

          </fieldset>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          {busy ? <p role="status" className="text-sm text-on-surface-variant">Saving this revision. Keep this editor open until the request finishes.</p> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
