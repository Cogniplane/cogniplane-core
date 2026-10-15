import type { AdminUser } from "@cogniplane/shared-types";

import { ApiError } from "../../../lib/api-client";

export type MemberRole = AdminUser["role"];
export type Actor = { userId: string; role: MemberRole };

const ROLES: MemberRole[] = ["member", "admin", "owner"];

export const ROLE_INFO: Record<MemberRole, { label: string; summary: string }> = {
  member: {
    label: "Member",
    summary: "Uses the workspace with the skills and connections released to members. No admin area."
  },
  admin: {
    label: "Admin",
    summary: "Manages models, connections, skills, policies, and people. Can remove members. Cannot remove admins or change roles."
  },
  owner: {
    label: "Owner",
    summary: "Has all admin access, and can change roles and owner-only settings such as provider API keys."
  }
};

export function displayName(user: Pick<AdminUser, "displayName" | "email" | "userId">): string {
  return user.displayName?.trim() || user.email?.trim() || user.userId;
}

/*
 * These rules mirror PUT and DELETE /tenant/members/:userId in
 * apps/backend/src/routes/tenant.ts. The backend stays the authority; the page
 * uses these only to hide actions that the backend would reject.
 */

/** Roles the actor can move the target to. Empty when the role is locked. */
export function roleChoices(actor: Actor, target: Pick<AdminUser, "userId" | "role">): MemberRole[] {
  if (roleLockReason(actor, target)) return [];
  return ROLES.filter((role) => role !== target.role);
}

export function roleLockReason(actor: Actor, target: Pick<AdminUser, "userId" | "role">): string | null {
  if (actor.userId === target.userId) return "You cannot change your own role.";
  if (target.role === "owner") return "An owner keeps the owner role. No one can demote an owner.";
  if (actor.role !== "owner") return "Only owners can change roles.";
  return null;
}

export function removeLockReason(actor: Actor, target: Pick<AdminUser, "userId" | "role">): string | null {
  if (actor.userId === target.userId) return "You cannot remove yourself.";
  if (target.role === "owner") return "Owners cannot be removed.";
  if (actor.role !== "owner" && actor.role !== "admin") return "Only owners and admins can remove people.";
  if (target.role === "admin" && actor.role !== "owner") return "Only owners can remove an admin.";
  return null;
}

/** What a role change does, in the order the confirmation lists it. */
export function roleChangeEffects(from: MemberRole, to: MemberRole, name: string): string[] {
  const effects: string[] = [];
  if (to === "owner") {
    effects.push(`${name} gets all admin access, and can change roles and owner-only settings.`);
    effects.push("You cannot undo this. No one, including other owners, can demote or remove an owner.");
  } else if (to === "admin") {
    effects.push(`${name} can open the admin area and change organization setup.`);
    effects.push(`${name} can remove members.`);
    effects.push("Only an owner can change this role again.");
  } else if (from === "admin") {
    effects.push(`${name} loses access to the admin area.`);
    effects.push("Their chats, files, and projects stay as they are.");
  }
  effects.push("The change applies to their next request.");
  return effects;
}

export const REMOVAL_EFFECTS = [
  "They lose access to this organization on their next request.",
  "Their scheduled jobs are turned off, and agent runs in progress stop.",
  "Their personal skills, personal tool choices, and saved credentials for organization connections are deleted.",
  "The system tries to delete their connected accounts, such as GitHub or Notion. It cannot guarantee revocation at the external service."
];

export const REMOVAL_LIMITS =
  "Their past sessions are not deleted. You cannot undo this. To give access again, they must be added to the organization again.";

export const TEST_ACCESS_SCOPE =
  "Test users can use skill releases and connections that an admin released to test users. Unreleased drafts stay hidden.";

const ERROR_MESSAGES: Record<string, string> = {
  only_owner_can_assign_owner: "Only owners can make someone an owner.",
  only_owner_can_assign_admin: "Only owners can make someone an admin.",
  only_owner_can_change_admin_role: "Only owners can change an admin's role.",
  cannot_change_own_role: "You cannot change your own role.",
  cannot_demote_owner: "An owner cannot be demoted.",
  cannot_remove_self: "You cannot remove yourself.",
  cannot_remove_owner: "Owners cannot be removed.",
  only_owner_can_remove_admin: "Only owners can remove an admin.",
  member_not_found: "This person is no longer a member of the organization.",
  user_not_found: "This person is no longer a member of the organization."
};

export function memberActionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const known = error.code ? ERROR_MESSAGES[error.code] : undefined;
    if (known) return known;
    if (error.status === 403) return "You do not have permission to do this.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isMemberGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
