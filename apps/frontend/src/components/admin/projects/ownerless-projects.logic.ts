import type { AdminUser } from "@cogniplane/shared-types";

import { ApiError } from "../../../lib/api-client";
import { displayName } from "../people/person-access.logic";

/** What a person sees for one choice in the owner list. */
export function ownerChoiceLabel(user: Pick<AdminUser, "displayName" | "email" | "userId">): string {
  const name = displayName(user);
  const email = user.email?.trim();
  return email && email !== name ? `${name} (${email})` : name;
}

export type OwnerConfirmation = { title: string; effects: string[]; selfWarning: string | null };

/** The text of the confirmation before an admin assigns an owner. The owner
 *  of a project can open everything in it, so say that. An admin who picks
 *  themselves gets the same access, so say that too. */
export function ownerConfirmation(projectName: string, personName: string, isSelf: boolean): OwnerConfirmation {
  return {
    title: `Make ${personName} the owner of ${projectName}?`,
    effects: [
      `${personName} will be able to open and manage everything in this project: its sessions, files, drafts, settings, and sharing.`,
      "The other members of the project keep the access that they have now.",
      "The change is recorded in the audit log, with your name."
    ],
    selfWarning: isSelf
      ? "You chose yourself. You will get access to everything in this project. Choose someone else if you only want to give the project an owner."
      : null
  };
}

/** The message for a failed assignment. The backend names the cause in `code`. */
export function recoveryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "project_has_owner":
        return "This project already has an owner. The list is out of date, so it was loaded again.";
      case "organization_member_not_found":
        return "That person is no longer a member of the organization. Choose someone else.";
      case "organization_admin_required":
        return "Only organization admins can assign a project owner.";
      case "project_not_found":
        return "This project is not available. It was removed, or it is in another organization.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : "The owner was not assigned. Try again.";
}

/** True when the list itself was refused because the person is not an admin. */
export function isAdminRequiredError(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "organization_admin_required" || error.status === 403);
}
