"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Skeleton } from "@/components/ui/skeleton";
import { listAdminUsers } from "../../../lib/admin-api";
import { listOwnerlessProjects, recoverProjectOwner } from "../../../lib/admin-projects-api";
import { useAuth } from "../../../lib/auth-context";
import { toErrorMessage } from "../../../lib/error-utils";
import { PROJECT_SELECT } from "../../../lib/project-ui";
import { queryKeys } from "../../../lib/query-keys";
import { displayName } from "../people/person-access.logic";
import {
  isAdminRequiredError,
  ownerChoiceLabel,
  ownerConfirmation,
  recoveryErrorMessage
} from "./ownerless-projects.logic";

const OWNERLESS_KEY = [...queryKeys.admin.all, "ownerless-projects"] as const;

function withoutChoice(choices: Record<string, string>, projectId: string): Record<string, string> {
  const next = { ...choices };
  delete next[projectId];
  return next;
}

type Assignment = { projectId: string; projectName: string; userId: string; personName: string };

/** The recovery screen for projects that have no owner (decision D13j). It
 *  shows project names only. It does not open a project, and it reads no
 *  project content. An admin picks a current member of the organization, and
 *  the existing audited route makes that person the owner. */
export function OwnerlessProjects() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const projects = useQuery({ queryKey: OWNERLESS_KEY, queryFn: listOwnerlessProjects, retry: false });
  const list = useMemo(() => projects.data ?? [], [projects.data]);
  const people = useQuery({ queryKey: queryKeys.admin.users(), queryFn: listAdminUsers, enabled: list.length > 0 });
  const choices = useMemo(
    () => [...(people.data ?? [])].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [people.data]
  );
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const assign = useMutation({
    mutationFn: (value: Assignment) => recoverProjectOwner(value.projectId, value.userId),
    onSuccess: async (_result, value) => {
      setAssignment(null);
      setFailure(null);
      setPicked((current) => withoutChoice(current, value.projectId));
      toast.success(`${value.personName} is now the owner of ${value.projectName}.`);
      await queryClient.invalidateQueries({ queryKey: OWNERLESS_KEY });
    },
    onError: async (error, value) => {
      setAssignment(null);
      setFailure(recoveryErrorMessage(error));
      setPicked((current) => withoutChoice(current, value.projectId));
      // The project or the person can have changed. Load both lists again.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: OWNERLESS_KEY }),
        queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() })
      ]);
    }
  });

  const refused = projects.isError && isAdminRequiredError(projects.error);
  const confirmation = assignment
    ? ownerConfirmation(assignment.projectName, assignment.personName, assignment.userId === me?.userId)
    : null;

  return (
    <section aria-labelledby="ownerless-heading" className="flex flex-col gap-4 pt-5">
      <div className="border-b border-outline-variant pb-4">
        <h2 id="ownerless-heading" className="text-xl font-semibold tracking-tight text-on-surface">Projects without an owner</h2>
        <p className="mt-1 max-w-3xl text-sm text-on-surface-variant">
          A project has no owner when its last owner left or lost the role. Its members keep their access,
          but nobody can change owner-only settings such as sharing. Choose a person to make the owner.
          This screen shows project names only. It does not give you access to a project or its content.
        </p>
      </div>

      {failure ? <p role="alert" className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger">{failure}</p> : null}

      {projects.isPending ? (
        <div role="status" aria-label="Loading projects" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : null}

      {refused ? (
        <p role="status" className="py-6 text-sm text-on-surface-variant">
          Only organization admins can see and recover projects without an owner.
        </p>
      ) : null}

      {projects.isError && !refused ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-danger">Could not load projects. {toErrorMessage(projects.error, "")}</p>
          <Button variant="outline" size="sm" onClick={() => void projects.refetch()}>Retry</Button>
        </div>
      ) : null}

      {projects.data && list.length === 0 ? (
        <p role="status" className="py-6 text-sm text-on-surface-faint">Every project has an owner.</p>
      ) : null}

      {people.isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-danger">Could not load the people of the organization. {toErrorMessage(people.error, "")}</p>
          <Button variant="outline" size="sm" onClick={() => void people.refetch()}>Retry</Button>
        </div>
      ) : null}

      {list.length > 0 ? (
        <ul aria-label="Projects without an owner" className="divide-y divide-outline-variant">
          {list.map((project) => {
            const userId = picked[project.projectId] ?? "";
            const person = choices.find((candidate) => candidate.userId === userId);
            return (
              <li key={project.projectId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface" title={project.name}>{project.name}</span>
                <select
                  aria-label={`New owner for ${project.name}`}
                  className={`${PROJECT_SELECT} sm:w-72`}
                  value={userId}
                  disabled={!people.data || assign.isPending}
                  onChange={(event) => setPicked((current) => ({ ...current, [project.projectId]: event.target.value }))}
                >
                  <option value="">{people.isPending ? "Loading people…" : "Choose a person"}</option>
                  {choices.map((candidate) => (
                    <option key={candidate.userId} value={candidate.userId}>
                      {ownerChoiceLabel(candidate)}{candidate.userId === me?.userId ? " (you)" : ""}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Assign owner for ${project.name}`}
                  disabled={!person || assign.isPending}
                  onClick={() => {
                    if (!person) return;
                    setFailure(null);
                    setAssignment({
                      projectId: project.projectId,
                      projectName: project.name,
                      userId: person.userId,
                      personName: displayName(person)
                    });
                  }}
                >
                  Assign owner
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <AlertDialog open={assignment !== null} onOpenChange={(open) => { if (!open && !assign.isPending) setAssignment(null); }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>An owner can manage the project and everything in it. Check the effects before you continue.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
            {confirmation?.effects.map((effect) => <li key={effect} className="wrap-anywhere">{effect}</li>)}
          </ul>
          {confirmation?.selfWarning ? (
            <p role="alert" className="text-sm font-medium text-danger">{confirmation.selfWarning}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={assign.isPending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => { if (assignment) assign.mutate(assignment); }}
              disabled={assign.isPending}
              aria-busy={assign.isPending}
            >
              {assign.isPending ? "Assigning…" : "Make owner"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
