"use client";

import { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type InlineSkillDraft = {
  skillId: string;
  skillName: string;
  description: string;
  instructions: string;
};

export const emptyInlineSkillDraft: InlineSkillDraft = {
  skillId: "",
  skillName: "",
  description: "",
  instructions: ""
};

export function AdminSkillInlineTab(props: {
  busyKey: string | null;
  draft: InlineSkillDraft;
  onDraftChange: (draft: InlineSkillDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const isBusy = props.busyKey === "skill-import-inline";
  const submitDisabled =
    isBusy
    || !props.draft.skillId.trim()
    || !props.draft.skillName.trim()
    || !props.draft.description.trim()
    || !props.draft.instructions.trim();

  return (
    <form onSubmit={props.onSubmit} className="flex flex-col gap-4 px-1 py-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-inline-id">Skill ID</Label>
        <Input
          id="skill-inline-id"
          name="skill-inline-id"
          type="text"
          placeholder="my-skill"
          value={props.draft.skillId}
          onChange={(event) =>
            props.onDraftChange({ ...props.draft, skillId: event.target.value })
          }
        />
        <p className="text-xs text-on-surface-variant">
          Lowercase letters, numbers, and single hyphens. Used as the directory name.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-inline-name">Display name</Label>
        <Input
          id="skill-inline-name"
          name="skill-inline-name"
          type="text"
          placeholder="My Skill"
          value={props.draft.skillName}
          onChange={(event) =>
            props.onDraftChange({ ...props.draft, skillName: event.target.value })
          }
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-inline-description">Description</Label>
        <Input
          id="skill-inline-description"
          name="skill-inline-description"
          type="text"
          placeholder="What this skill does, in one sentence."
          value={props.draft.description}
          onChange={(event) =>
            props.onDraftChange({ ...props.draft, description: event.target.value })
          }
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-inline-instructions">Instructions (SKILL.md body)</Label>
        <Textarea
          id="skill-inline-instructions"
          name="skill-inline-instructions"
          rows={20}
          className="font-mono"
          placeholder={"# When to use\n\nDescribe triggers and behavior here..."}
          value={props.draft.instructions}
          onChange={(event) =>
            props.onDraftChange({ ...props.draft, instructions: event.target.value })
          }
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={submitDisabled}>
          {isBusy ? "Creating..." : "Create skill"}
        </Button>
      </div>
    </form>
  );
}
