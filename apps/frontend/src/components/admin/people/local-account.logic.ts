import type { AdminUser, LinkEmailStatus, LocalAccountStatus } from "@cogniplane/shared-types";

import type { Actor, MemberRole } from "./person-access.logic";

/*
 * Local accounts (docs/architecture/local-accounts.md). These
 * rules mirror apps/backend/src/routes/tenant-local-members.ts. The backend
 * stays the authority; the page uses them only to hide refused actions.
 */

export const ACCOUNT_STATUS_INFO: Record<Exclude<LocalAccountStatus, "removed">, { label: string; summary: string }> = {
  pending_setup: { label: "Not set up", summary: "Has not set a password yet. The setup link works for 72 hours." },
  active: { label: "Active", summary: "Signs in with email and password." },
  disabled: { label: "Disabled", summary: "Cannot sign in. Scheduled jobs are off." }
};

export function accountStatusOf(person: Pick<AdminUser, "accountStatus">): Exclude<LocalAccountStatus, "removed"> | null {
  const status = person.accountStatus;
  return status && status !== "removed" ? status : null;
}

/** Why the actor cannot manage this person's sign-in, or null when they can. */
export function signInLockReason(actor: Actor, target: Pick<AdminUser, "userId" | "role">): string | null {
  if (actor.userId === target.userId) return "Manage your own sign-in in Settings › Sign-in & security.";
  if (actor.role !== "owner" && actor.role !== "admin") return "Only owners and admins can manage sign-in.";
  if (target.role === "owner") return "No one can reset or disable an owner's account here.";
  if (target.role === "admin" && actor.role !== "owner") return "Only owners can manage an admin's sign-in.";
  return null;
}

/** A short reason for a failed link email, from its error code (never server text). */
function linkEmailFailure(code: string | null): string {
  if (code === "BAD_ADDRESS") return "the address is not a valid email address";
  if (code?.startsWith("EENVELOPE 5")) return "the mail server refused the address";
  if (code?.startsWith("EMESSAGE 5")) return "the mail server refused the message";
  return "the mail server could not be reached";
}

/** One line about the latest link email, for managers. */
export function linkEmailSummary(linkEmail: LinkEmailStatus): string {
  const what = linkEmail.purpose === "account_setup" ? "setup link" : "password reset link";
  const when = formatExpiry(linkEmail.updatedAt);
  switch (linkEmail.status) {
    case "queued":
    case "sending":
      return linkEmail.error
        ? `The ${what} email is waiting to be sent again (${linkEmailFailure(linkEmail.error)}).`
        : `The ${what} email is waiting to be sent.`;
    case "sent":
      return `The ${what} email went out ${when}.`;
    case "failed":
      return `The ${what} email could not be sent: ${linkEmailFailure(linkEmail.error)}.`;
    case "expired":
      return `The ${what} email was not sent: its link ended first (it expired or was replaced).`;
  }
}

/**
 * With email on: offer "Send the link again" to an account not set up yet,
 * or when the latest link email did not go out.
 */
export function mayResendLink(status: LocalAccountStatus | null, linkEmail: LinkEmailStatus | null | undefined): boolean {
  if (status === "pending_setup") return true;
  return status === "active" && (linkEmail?.status === "failed" || linkEmail?.status === "expired");
}

/**
 * Roles the actor may give a new person. Never owner: a new account is not set
 * up yet, and nobody can reset an owner's account here. An owner makes the
 * person an owner after setup.
 */
export function newPersonRoles(actor: Actor): MemberRole[] {
  return actor.role === "owner" ? ["member", "admin"] : ["member"];
}

export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}
