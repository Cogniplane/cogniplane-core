"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AdminUser } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { changeMemberRole, removeMember, setUserBetaTester } from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";
import {
  displayName,
  isMemberGone,
  memberActionError,
  removeLockReason,
  ROLE_INFO,
  roleChoices,
  roleLockReason,
  TEST_ACCESS_SCOPE,
  type Actor,
  type MemberRole
} from "./person-access.logic";
import { RemoveMemberDialog } from "./remove-member-dialog";
import { RoleChangeDialog } from "./role-change-dialog";

const ROW = "flex flex-col gap-2 py-4";
const ROW_LABEL = "text-xs font-semibold uppercase tracking-wide text-on-surface-variant";

export function PersonAccess({ person, actor }: { person: AdminUser; actor: Actor }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const name = displayName(person);
  const [status, setStatus] = useState("");
  const [roleOpen, setRoleOpen] = useState(false);
  // A new key per opening starts the role dialog at its first step.
  const [roleDialogKey, setRoleDialogKey] = useState(0);
  const [removeOpen, setRemoveOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const roleButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);

  // The dialogs open without a Radix trigger, so Radix does not know where to
  // return focus. Return it to the button that opened the dialog. If that
  // button is gone (for example, after a promotion to owner), use the heading.
  // Read the refs only in the close event, not during render.
  const restoreFocus = (event: Event, trigger: HTMLElement | null) => {
    event.preventDefault();
    (trigger ?? headingRef.current)?.focus();
  };
  const handleRoleDialogCloseFocus = (event: Event) => restoreFocus(event, roleButtonRef.current);
  const handleRemoveDialogCloseFocus = (event: Event) => restoreFocus(event, removeButtonRef.current);

  const refreshPeople = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
  // Test access changes which test-only resources this person gets.
  const refreshPersonAccess = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.personAccessAll() });

  const testAccess = useMutation({
    mutationFn: (next: boolean) => setUserBetaTester(person.userId, next),
    onMutate: () => setStatus(""),
    onSuccess: async (user) => {
      void refreshPersonAccess();
      await refreshPeople();
      setStatus(user.isBetaTester ? "Test access is on." : "Test access is off.");
    },
    onError: (error) => { if (isMemberGone(error)) void refreshPeople(); }
  });

  const role = useMutation({
    mutationFn: (next: MemberRole) => changeMemberRole(person.userId, next),
    onMutate: () => setStatus(""),
    onSuccess: async (_result, next) => {
      await refreshPeople();
      setRoleOpen(false);
      setStatus(`Role changed to ${ROLE_INFO[next].label.toLowerCase()}.`);
    },
    onError: (error) => { if (isMemberGone(error)) void refreshPeople(); }
  });

  const removal = useMutation({
    mutationFn: () => removeMember(person.userId),
    onSuccess: () => finishRemoval(`${name} was removed from the organization.`),
    onError: (error) => {
      if (isMemberGone(error)) finishRemoval(`${name} is no longer a member of the organization.`);
    }
  });

  function finishRemoval(message: string) {
    queryClient.removeQueries({ queryKey: queryKeys.admin.memberMonthUsage(person.userId) });
    queryClient.removeQueries({ queryKey: queryKeys.admin.personAccessAll() });
    void refreshPeople();
    setRemoveOpen(false);
    toast.success(message);
    router.push("/admin/users");
  }

  const choices = roleChoices(actor, person);
  const roleLock = roleLockReason(actor, person);
  const removeLock = removeLockReason(actor, person);

  return (
    <aside aria-labelledby="person-access-heading" className="min-w-0 lg:border-l lg:border-outline-variant lg:pl-8">
      <h3 ref={headingRef} id="person-access-heading" tabIndex={-1} className="text-lg font-semibold text-on-surface outline-none">Access</h3>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-success">{status}</p>

      <div className="divide-y divide-outline-variant">
        <section aria-label="Role" className={ROW}>
          <h4 className={ROW_LABEL}>Role</h4>
          <p className="text-base font-semibold text-on-surface">{ROLE_INFO[person.role].label}</p>
          <p className="text-sm text-on-surface-variant">{ROLE_INFO[person.role].summary}</p>
          {choices.length > 0 ? (
            <Button ref={roleButtonRef} variant="outline" size="sm" className="self-start" onClick={() => { role.reset(); setRoleDialogKey((key) => key + 1); setRoleOpen(true); }}>
              Change role
            </Button>
          ) : (
            <p className="text-xs text-on-surface-faint">{roleLock}</p>
          )}
        </section>

        <section aria-label="Test access" className={ROW}>
          <h4 className={ROW_LABEL}>Test access</h4>
          <p className="text-base font-semibold text-on-surface">{person.isBetaTester ? "On" : "Off"}</p>
          <p className="text-sm text-on-surface-variant">{TEST_ACCESS_SCOPE}</p>
          <Button
            variant={person.isBetaTester ? "outline" : "secondary"}
            size="sm"
            className="self-start"
            disabled={testAccess.isPending}
            aria-busy={testAccess.isPending}
            onClick={() => testAccess.mutate(!person.isBetaTester)}
          >
            {testAccess.isPending ? "Saving…" : person.isBetaTester ? "Turn off test access" : "Turn on test access"}
          </Button>
          {testAccess.error ? (
            <p role="alert" className="text-sm text-danger">
              {memberActionError(testAccess.error, "Could not change test access.")}
            </p>
          ) : null}
        </section>
      </div>

      <div className="mt-6 border-t border-dashed border-outline-variant pt-4">
        {removeLock ? (
          <p className="text-xs text-on-surface-faint">{removeLock}</p>
        ) : (
          <>
            <Button
              ref={removeButtonRef}
              variant="ghost"
              size="sm"
              className="-ml-3 text-danger hover:bg-danger-surface hover:text-danger"
              onClick={() => { removal.reset(); setRemoveOpen(true); }}
            >
              Remove from organization…
            </Button>
            <p className="mt-1 text-xs text-on-surface-faint">Ends their access. You cannot undo this.</p>
          </>
        )}
      </div>

      <RoleChangeDialog
        key={roleDialogKey}
        open={roleOpen}
        onOpenChange={setRoleOpen}
        onCloseAutoFocus={handleRoleDialogCloseFocus}
        name={name}
        currentRole={person.role}
        choices={choices}
        pending={role.isPending}
        error={role.error ? memberActionError(role.error, "Could not change the role.") : null}
        onConfirm={(next) => role.mutate(next)}
      />
      <RemoveMemberDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onCloseAutoFocus={handleRemoveDialogCloseFocus}
        name={name}
        pending={removal.isPending}
        error={removal.error && !isMemberGone(removal.error) ? memberActionError(removal.error, "Could not remove this person.") : null}
        onConfirm={() => removal.mutate()}
      />
    </aside>
  );
}
