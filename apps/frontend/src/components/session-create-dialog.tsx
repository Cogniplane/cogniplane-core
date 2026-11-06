"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Starts a session in a chosen project. It stays outside the session sidebar,
 * because the phone drawer unmounts the sidebar while it is closed, and the
 * New session shortcut must still work at that time. Mount it again for each
 * opening, so each one starts with a personal session and no error.
 */
export function SessionCreateDialog({ open, onOpenChange, projects, isCreating, onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  isCreating?: boolean;
  onCreate: (projectId: string | null) => Promise<void>;
}) {
  const [createProjectId, setCreateProjectId] = useState("personal");
  const [createError, setCreateError] = useState<string | null>(null);
  // A create from an earlier opening may finish after a new opening mounts.
  // Only the opening that sent it closes or reports.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);
  const selectedProjectId = createProjectId === "personal" || activeProjects.some((project) => project.projectId === createProjectId)
    ? createProjectId
    : "personal";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Choose where this conversation should live. Personal sessions stay private.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              setCreateError(null);
              await onCreate(selectedProjectId === "personal" ? null : selectedProjectId);
              if (mounted.current) onOpenChange(false);
            } catch (error) {
              if (mounted.current) setCreateError(error instanceof Error ? error.message : "Could not create the session.");
            }
          }}
        >
          <label htmlFor="new-session-project" className="block text-sm font-medium text-on-surface">Project</label>
          <select
            id="new-session-project"
            className="h-10 w-full rounded-md border border-input bg-surface-container-lowest px-3 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-brand"
            value={selectedProjectId}
            onChange={(event) => setCreateProjectId(event.target.value)}
            disabled={isCreating}
          >
            <option value="personal">Personal session</option>
            {activeProjects.map((project) => (
              <option key={project.projectId} value={project.projectId}>{project.name}</option>
            ))}
          </select>
          {selectedProjectId !== "personal" ? (
            <p className="text-xs text-on-surface-variant">This session will follow the project&apos;s access and sharing settings.</p>
          ) : null}
          {createError ? <p role="alert" className="text-sm text-danger">{createError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>Cancel</Button>
            <Button type="submit" disabled={isCreating || (selectedProjectId !== "personal" && !activeProjects.some((project) => project.projectId === selectedProjectId))}>
              {isCreating ? "Creating..." : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
