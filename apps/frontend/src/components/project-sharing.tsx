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
import type { Project } from "@cogniplane/shared-types";
import { PROJECT_SELECT } from "@/lib/project-ui";
type SharingDraft = {
  visibility: "private" | "organization";
  organizationRole: "viewer" | "editor";
};

export function ProjectSharing({ project, canManage = true }: { project: Project; canManage?: boolean }) {
  const client = useQueryClient();
  const access = useQuery({
    queryKey: ["projects", project.projectId, "access"],
    queryFn: () => getProjectAccess(project.projectId),
    retry: false
  });
  const [draft, setDraft] = useState<SharingDraft | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);

  const visibility = draft?.visibility ?? access.data?.visibility ?? "private";
  const organizationRole = draft?.organizationRole ?? access.data?.organizationRole ?? "viewer";

  const savedVisibility = access.data?.visibility;
  const savedRole = access.data?.organizationRole;
  const changed = visibility !== savedVisibility || organizationRole !== savedRole;
  const promoting = visibility === "organization" && savedVisibility !== "organization";
  const changingOrganizationRole = visibility === "organization" &&
    savedVisibility === "organization" && organizationRole !== savedRole;
  const needsAudienceConfirmation = promoting || changingOrganizationRole;
  const save = useMutation({
    mutationFn: (confirmAudience: boolean) => updateProjectSharing(project.projectId, {
      visibility,
      organizationRole: visibility === "organization" ? organizationRole : (savedRole ?? "viewer"),
      confirmAudience
    }),
    onSuccess: async () => {
      setDraft(null);
      setConfirmOpen(false);
      setChangedElsewhere(false);
      await client.invalidateQueries({ queryKey: ["projects", project.projectId, "access"] });
      toast.success("Project access updated.");
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "project_audience_confirmation_required") {
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
            {visibility === "organization" ? "Organization shared" : "Private"}
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
            if (needsAudienceConfirmation) setConfirmOpen(true);
            else save.mutate(false);
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
            {visibility === "organization"
              ? organizationRole === "editor"
                ? "Everyone in your organization can open the project and make changes."
                : "Everyone in your organization can open the project, its sessions, and its files, but cannot make changes."
              : savedVisibility === "organization"
                ? `Organization sharing is off. The last organization permission, ${savedRole === "editor" ? "edit" : "view"}, will be kept if you share this project again.`
                : "Only the project owner and any project members can access it."}
          </p>
          {changedElsewhere && access.data ? (
            <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger-surface px-3 py-2 text-sm text-danger">
              <p>
                Project access changed in another tab. Your draft is preserved, but the saved setting is now {access.data.visibility === "organization"
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
          <div className="border-t border-outline-variant pt-4">
            <h4 className="text-sm font-medium">Project members</h4>
            {access.data.members.length ? (
              <ul className="mt-2 divide-y divide-outline-variant text-sm">
                {access.data.members.map((member) => (
                  <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {member.displayName ?? member.email ?? member.userId}
                      {member.displayName && member.email ? (
                        <span className="ml-2 text-on-surface-variant">{member.email}</span>
                      ) : null}
                    </span>
                    <span className="text-on-surface-variant">{member.role}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-on-surface-variant">No explicit project members.</p>
            )}
            {visibility === "organization" ? (
              <p className="mt-2 text-xs text-on-surface-variant">
                Organization sharing also gives every current organization member the selected access above.
              </p>
            ) : null}
          </div>
          {save.isError && !changedElsewhere ? <p role="alert" className="text-sm text-danger">{save.error.message}</p> : null}
          <Button type="submit" disabled={!canManage || !changed || changedElsewhere || Boolean(project.archivedAt) || save.isPending}>
            {save.isPending ? "Saving access..." : "Save access"}
          </Button>
          {project.archivedAt ? <p className="text-xs text-on-surface-variant">Restore the project before changing access.</p> : null}
        </form>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {promoting
                ? "Share this project with your organization?"
                : `Change organization access to ${organizationRole === "editor" ? "edit" : "view"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {promoting
                ? `Everyone in your organization will get ${organizationRole === "editor" ? "edit" : "view"} access to this project. Its existing conversations, attachments, files, and drafts will be included. You can make the project private again later.`
                : `Everyone in your organization already has access. This will change their permission to ${organizationRole === "editor" ? "edit" : "view"} for this project.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                save.mutate(true);
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
