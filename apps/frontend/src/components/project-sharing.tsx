"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getProjectAccess, updateProjectSharing } from "@/lib/project-api";
import { ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { Project, ProjectSharingState } from "@cogniplane/shared-types";
import { PROJECT_SELECT } from "@/lib/project-ui";
import { ProjectMembers } from "./project-members";

/** A sharing save: the saved access that the owner saw, and the access they chose. */
type SharingChange = { expected: ProjectSharingState; next: ProjectSharingState };

function needsAudienceConfirmation({ expected, next }: SharingChange) {
  return next.visibility === "organization" &&
    (expected.visibility !== "organization" || expected.organizationRole !== next.organizationRole);
}

const permission = (role: ProjectSharingState["organizationRole"]) => role === "editor" ? "edit" : "view";

export function ProjectSharing({ project, canManage = true, currentUserId }: {
  project: Project;
  canManage?: boolean;
  /** The person at the page. Their row in the member list says Leave. */
  currentUserId?: string;
}) {
  const client = useQueryClient();
  const access = useQuery({
    queryKey: ["projects", project.projectId, "access"],
    queryFn: () => getProjectAccess(project.projectId),
    retry: false
  });
  const [draft, setDraft] = useState<ProjectSharingState | null>(null);
  // The change that the dialog describes. Confirm sends this change. The access
  // query can refresh while the dialog is open, and then it no longer matches.
  const [confirmation, setConfirmation] = useState<SharingChange | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);

  const visibility = draft?.visibility ?? access.data?.visibility ?? "private";
  const organizationRole = draft?.organizationRole ?? access.data?.organizationRole ?? "viewer";

  const savedVisibility = access.data?.visibility;
  const savedRole = access.data?.organizationRole;
  const changed = visibility !== savedVisibility || organizationRole !== savedRole;
  const promoting = confirmation?.expected.visibility !== "organization";
  const save = useMutation({
    mutationFn: ({ change, confirmAudience }: { change: SharingChange; confirmAudience: boolean }) =>
      updateProjectSharing(project.projectId, { ...change.next, expected: change.expected, confirmAudience }),
    onSuccess: async () => {
      setDraft(null);
      setConfirmOpen(false);
      setChangedElsewhere(false);
      await client.invalidateQueries({ queryKey: ["projects", project.projectId, "access"] });
      toast.success("Project access updated.");
    },
    onError: async (error) => {
      // The saved access is not the access that the owner saw. Show it and ask
      // for a new change, which builds a new confirmation from it.
      if (error instanceof ApiError &&
          (error.code === "project_sharing_conflict" || error.code === "project_audience_confirmation_required")) {
        setConfirmOpen(false);
        await client.invalidateQueries({ queryKey: ["projects", project.projectId, "access"] });
        setChangedElsewhere(true);
      }
    }
  });

  const errorIsPermission = access.error instanceof ApiError && access.error.code === "project_role_required";

  return (
    <section
      aria-labelledby="project-sharing-title"
      className="rounded-lg border border-outline-variant bg-surface-container-low p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="project-sharing-title" className="font-semibold">Project access</h3>
          <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">
            Projects start private. Share this project with your organization when other people
            need its conversations, files, or drafts.
          </p>
        </div>
        {access.data ? (
          <span className="rounded-full border border-outline-variant px-2.5 py-1 text-xs font-medium text-on-surface-variant">
            {savedVisibility === "organization" ? "Organization shared" : "Members only"}
          </span>
        ) : null}
      </div>

      {access.isPending ? <Skeleton aria-label="Loading project access" className="mt-5 h-24" /> : null}

      {access.isError ? (
        <p className="mt-4 text-sm text-on-surface-variant" role={errorIsPermission ? undefined : "alert"}>
          {errorIsPermission
            ? "Only the project owner can manage who can access this project."
            : "Could not load project access. Try refreshing the page."}
        </p>
      ) : null}

      {access.data ? (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!access.data) return;
            const expected = { visibility: access.data.visibility, organizationRole: access.data.organizationRole };
            // A members-only save keeps the saved organization role for a later share.
            const change = { expected, next: { visibility,
              organizationRole: visibility === "organization" ? organizationRole : expected.organizationRole } };
            if (needsAudienceConfirmation(change)) {
              setConfirmation(change);
              setConfirmOpen(true);
            } else save.mutate({ change, confirmAudience: false });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="project-visibility" className="text-sm font-medium">Who can access</label>
              <select
                id="project-visibility"
                className={`${PROJECT_SELECT} mt-1`}
                value={visibility}
                disabled={!canManage || Boolean(project.archivedAt) || save.isPending}
                onChange={(event) => {
                  const nextVisibility = event.target.value as "private" | "organization";
                  setDraft({
                    visibility: nextVisibility,
                    organizationRole: nextVisibility === "private" ? (savedRole ?? "viewer") : organizationRole
                  });
                  setChangedElsewhere(false);
                  save.reset();
                }}
              >
                <option value="private">Only project members</option>
                <option value="organization">Everyone in the organization</option>
              </select>
            </div>
            <div>
              <label htmlFor="project-organization-role" className="text-sm font-medium">Organization access</label>
              <select
                id="project-organization-role"
                className={`${PROJECT_SELECT} mt-1`}
                value={organizationRole}
                disabled={!canManage || visibility !== "organization" || Boolean(project.archivedAt) || save.isPending}
                onChange={(event) => {
                  setDraft({
                    visibility,
                    organizationRole: event.target.value as "viewer" | "editor"
                  });
                  setChangedElsewhere(false);
                  save.reset();
                }}
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
            </div>
          </div>
          <p className="max-w-2xl text-sm text-on-surface-variant">
            {savedVisibility === "organization"
              ? `Current access: everyone in your organization can ${savedRole === "editor" ? "open the project and make changes" : "view the project, its sessions, and its files"}. Project members keep their explicit roles.`
              : "Current access: only project members can access this project."}
          </p>
          {changed ? <p role="status" className="max-w-2xl rounded-md bg-surface-container px-3 py-2 text-sm">
            <span className="font-medium">Unsaved access change. </span>
            {visibility === "organization"
              ? `After you save and confirm, everyone in your organization will have ${organizationRole === "editor" ? "edit" : "view"} access.`
              : `After you save, only project members will have access. The last organization permission, ${savedRole === "editor" ? "edit" : "view"}, will be kept if you share this project again.`}
          </p> : null}
          {changedElsewhere && access.data ? (
            <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger-surface px-3 py-2 text-sm text-danger">
              <p>
                Project access changed in another tab or by another owner. Your draft is preserved, but the saved setting is now {access.data.visibility === "organization"
                  ? `shared with the organization as ${access.data.organizationRole === "editor" ? "edit" : "view"}`
                  : "private"}.
              </p>
              <Button type="button" size="sm" variant="ghost" onClick={() => {
                setDraft(null);
                setChangedElsewhere(false);
                save.reset();
              }}>
                Use saved access
              </Button>
            </div>
          ) : null}
          <ProjectMembers
            projectId={project.projectId}
            access={access.data}
            canManage={canManage && !project.archivedAt}
            currentUserId={currentUserId}
            organizationNote={savedVisibility === "organization"}
          />
          {save.isError && !changedElsewhere ? <p role="alert" className="text-sm text-danger">{save.error.message}</p> : null}
          <Button type="submit" aria-busy={save.isPending} disabled={!canManage || !changed || changedElsewhere || Boolean(project.archivedAt) || save.isPending}>
            {save.isPending ? "Saving access..." : "Save access"}
          </Button>
          {!canManage ? <p className="text-sm text-on-surface-variant">Only project owners can change access and membership.</p> : null}
          {project.archivedAt ? <p className="text-xs text-on-surface-variant">Restore the project before changing access.</p> : null}
        </form>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          {confirmation ? <AlertDialogHeader>
            <AlertDialogTitle>
              {promoting
                ? "Share this project with your organization?"
                : `Change organization access to ${permission(confirmation.next.organizationRole)}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {promoting
                ? `Everyone in your organization will get ${permission(confirmation.next.organizationRole)} access to this project. Its existing conversations, attachments, files, and drafts will be included. You can make the project private again later.`
                : `Everyone in your organization already has ${permission(confirmation.expected.organizationRole)} access. This will change their permission to ${permission(confirmation.next.organizationRole)} for this project.`}
            </AlertDialogDescription>
          </AlertDialogHeader> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (confirmation) save.mutate({ change: confirmation, confirmAudience: true });
              }}
              disabled={save.isPending}
            >
              {save.isPending ? "Saving..." : "Confirm change"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
