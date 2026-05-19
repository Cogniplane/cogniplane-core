"use client";

import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  skillId: string;
  initialSkillName: string;
  initialDescription: string;
  initialInstructions: string;
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
  isBusy,
  onCancel,
  onSubmit
}: Props) {
  const [skillName, setSkillName] = useState(initialSkillName);
  const [description, setDescription] = useState(initialDescription);
  const [instructions, setInstructions] = useState(initialInstructions);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onSubmit({
      skillName: skillName.trim(),
      description: description.trim(),
      instructions
    });
  }

  const submitDisabled =
    isBusy || !skillName.trim() || !description.trim() || !instructions.trim();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit skill: {skillId}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <p className="text-sm text-on-surface-variant">
            Saving creates a new revision. The current active revision stays in place until you
            activate the new one from the revision panel.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-name">Display name</Label>
            <Input
              id="skill-edit-name"
              type="text"
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-description">Description</Label>
            <Input
              id="skill-edit-description"
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-edit-instructions">Instructions (SKILL.md body)</Label>
            <Textarea
              id="skill-edit-instructions"
              rows={20}
              className="font-mono"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {isBusy ? "Saving..." : "Save as new revision"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
