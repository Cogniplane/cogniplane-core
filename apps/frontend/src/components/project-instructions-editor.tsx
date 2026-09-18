"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MAX_PROJECT_INSTRUCTIONS_LENGTH, type Project } from "@cogniplane/shared-types";
import { updateProjectInstructions } from "@/lib/project-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "./ui/button";

export function ProjectInstructionsEditor({ project, canManage = true }: { project: Project; canManage?: boolean }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const text = draft?.text ?? project.instructions;
  const save = useMutation({
    mutationFn: () => updateProjectInstructions(project.projectId, text,
      draft?.revision ?? project.instructionsRevision),
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.projects.instructionsStatus(project.projectId), {
        projectId: saved.projectId, hasInstructions: Boolean(saved.instructions),
        instructionsRevision: saved.instructionsRevision
      });
      client.setQueryData(["projects", project.projectId], (current: { project: Project } | undefined) =>
        current ? { ...current, project: saved } : current);
      await client.invalidateQueries({ queryKey: ["projects"] });
      setDraft(null);
    },
    onError: async () => { await client.invalidateQueries({ queryKey: ["projects"] }); }
  });
  const changedElsewhere = draft !== null && draft.revision !== project.instructionsRevision;
  return <section aria-labelledby="project-instructions-title" className="rounded-lg border border-outline-variant bg-surface-container-low p-5">
    <h3 id="project-instructions-title" className="font-semibold">Instructions</h3>
    <p id="project-instructions-help" className="mt-1 text-sm text-on-surface-variant">
      Describe the project's purpose, constraints, and preferred outputs. These instructions apply to each session's next turn. Organization policy still applies.
    </p>
    <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label htmlFor="project-instructions" className="sr-only">Project instructions</label>
      <textarea id="project-instructions" aria-describedby="project-instructions-help" rows={6}
        maxLength={MAX_PROJECT_INSTRUCTIONS_LENGTH} value={text} disabled={!canManage || save.isPending}
        placeholder="Write in French. Quote amounts in CAD. Distinguish assumptions from confirmed requirements."
        className="w-full resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
        onChange={(event) => {
          setDraft({ text: event.target.value, revision: draft?.revision ?? project.instructionsRevision });
          save.reset();
        }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canManage || !draft || text === project.instructions || save.isPending || changedElsewhere}>
          {save.isPending ? "Saving..." : "Save instructions"}
        </Button>
        {draft ? <Button type="button" size="sm" variant="ghost" disabled={!canManage || save.isPending}
          onClick={() => { setDraft(null); save.reset(); }}>
          {changedElsewhere || save.isError ? "Use saved version" : "Cancel"}
        </Button> : null}
        <span className="ml-auto text-xs text-on-surface-variant">{text.length.toLocaleString()} / {MAX_PROJECT_INSTRUCTIONS_LENGTH.toLocaleString()}</span>
      </div>
      {!canManage ? <p className="text-sm text-on-surface-variant">Only project owners can change instructions.</p> : null}
      {changedElsewhere ? <p role="alert" className="text-sm text-danger">Instructions changed in another tab. Your draft is preserved. Use the saved version before editing again.</p> : null}
      {save.isError ? <p role="alert" className="text-sm text-danger">{save.error.message}</p> : null}
      {save.isSuccess && !draft ? <p role="status" className="text-sm text-on-surface-variant">Instructions saved. Changes apply to the next turn.</p> : null}
    </form>
  </section>;
}
