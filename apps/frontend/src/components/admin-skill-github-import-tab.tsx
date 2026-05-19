"use client";

import { FormEvent } from "react";

import type { GithubImportDraft } from "./admin-skill-card-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminSkillGithubImportTab(props: {
  draft: GithubImportDraft;
  busyKey: string | null;
  onDraftChange: (updater: (current: GithubImportDraft) => GithubImportDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="flex flex-col gap-4 px-1 py-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-github-url">GitHub repository URL</Label>
        <Input
          id="skill-github-url"
          placeholder="https://github.com/org/repo"
          value={props.draft.githubUrl}
          onChange={(event) =>
            props.onDraftChange((current) => ({ ...current, githubUrl: event.target.value }))
          }
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-github-ref">Ref</Label>
          <Input
            id="skill-github-ref"
            placeholder="main"
            value={props.draft.ref}
            onChange={(event) =>
              props.onDraftChange((current) => ({ ...current, ref: event.target.value }))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-github-subdirectory">Subdirectory</Label>
          <Input
            id="skill-github-subdirectory"
            placeholder="skills/pdf-processing"
            value={props.draft.subdirectory}
            onChange={(event) =>
              props.onDraftChange((current) => ({ ...current, subdirectory: event.target.value }))
            }
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!props.draft.githubUrl || props.busyKey === "skill-import-github"}
        >
          {props.busyKey === "skill-import-github" ? "Importing..." : "Import GitHub skill"}
        </Button>
      </div>
    </form>
  );
}
