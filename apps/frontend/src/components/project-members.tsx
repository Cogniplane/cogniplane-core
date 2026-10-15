"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { updateProjectMember } from "@/lib/project-api";
import { PROJECT_SELECT } from "@/lib/project-ui";
import {
  PROJECT_ROLES,
  describeMemberChange,
  memberName,
  type MemberChange,
  type ProjectAccess,
  type ProjectRole
} from "./project-members.logic";

/** The members of a project. An owner can change a role, remove a member, or
 *  leave. Every change asks first. When the change takes the role of the only
 *  owner, the question says that the project will have no owner. The backend
 *  allows that (decision D13j), and an organization admin can assign an owner. */
export function ProjectMembers({ projectId, access, canManage, currentUserId, organizationNote }: {
  projectId: string;
  access: ProjectAccess;
  /** The person can change members, and the project is not archived. */
  canManage: boolean;
  currentUserId?: string;
  /** Sharing is on, so it also gives access to every member of the organization. */
  organizationNote: boolean;
}) {
  const client = useQueryClient();
  const [change, setChange] = useState<MemberChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (value: { change: MemberChange; confirmRetainedRole: "viewer" | "editor" | undefined }) =>
      updateProjectMember(projectId, value.change.member.userId, {
        role: value.change.role,
        confirmRetainedRole: value.confirmRetainedRole
      }),
    onSuccess: async (_result, value) => {
      setChange(null);
      setError(null);
      const name = memberName(value.change.member);
      toast.success(value.change.role === null ? `${name} was removed from the project.` : `${name} is now ${value.change.role}.`);
      // The role of this person can decide what the page shows, so load it all again.
      await client.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : "The change was not saved. Try again.");
      // The members or the sharing can have changed. The dialog reads the new state.
      await client.invalidateQueries({ queryKey: ["projects", projectId, "access"] });
    }
  });

  const open = (next: MemberChange) => {
    setError(null);
    update.reset();
    setChange(next);
  };
  const notice = change ? describeMemberChange(access, change, change.member.userId === currentUserId) : null;

  return (
    <div className="border-t border-outline-variant pt-4">
      <h4 className="text-sm font-medium">Project members</h4>
      {access.members.length ? (
        <ul className="mt-2 divide-y divide-outline-variant text-sm">
          {access.members.map((member) => {
            const name = memberName(member);
            const self = member.userId === currentUserId;
            return (
              <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {member.displayName ?? member.email ?? member.userId}
                  {member.displayName && member.email ? (
                    <span className="ml-2 text-on-surface-variant">{member.email}</span>
                  ) : null}
                </span>
                {canManage ? (
                  <span className="flex items-center gap-2">
                    <select
                      aria-label={`Role of ${name}`}
                      className={`${PROJECT_SELECT} w-28`}
                      value={member.role}
                      disabled={update.isPending}
                      onChange={(event) => open({ member, role: event.target.value as ProjectRole })}
                    >
                      {PROJECT_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={self ? "Leave project" : `Remove ${name}`}
                      disabled={update.isPending}
                      onClick={() => open({ member, role: null })}
                    >
                      {self ? "Leave" : "Remove"}
                    </Button>
                  </span>
                ) : (
                  <span className="text-on-surface-variant">{member.role}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-on-surface-variant">No explicit project members.</p>
      )}
      {organizationNote ? (
        <p className="mt-2 text-xs text-on-surface-variant">
          Organization sharing also gives every current organization member the selected access above.
        </p>
      ) : null}

      <AlertDialog open={change !== null} onOpenChange={(next) => { if (!next && !update.isPending) setChange(null); }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">{notice?.title}</AlertDialogTitle>
            <AlertDialogDescription>Check the effects before you continue.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
            {notice?.details.map((line) => <li key={line} className="wrap-anywhere">{line}</li>)}
          </ul>
          {notice?.noOwnerWarning ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger-surface px-3 py-2 text-sm font-medium text-danger">
              {notice.noOwnerWarning}
            </p>
          ) : null}
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant={notice?.noOwnerWarning ? "destructive" : "default"}
              disabled={update.isPending}
              aria-busy={update.isPending}
              onClick={() => { if (change && notice) update.mutate({ change, confirmRetainedRole: notice.confirmRetainedRole }); }}
            >
              {update.isPending ? "Saving…" : error ? "Try again" : notice?.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
