import type { getProjectAccess } from "@/lib/project-api";

export type ProjectAccess = Awaited<ReturnType<typeof getProjectAccess>>;
export type ProjectMember = ProjectAccess["members"][number];
export type ProjectRole = ProjectMember["role"];
export type MemberChange = { member: ProjectMember; role: ProjectRole | null };

export const PROJECT_ROLES: readonly ProjectRole[] = ["owner", "editor", "viewer"];
const ROLE_PHRASE: Record<ProjectRole, string> = {
  owner: "an owner, who can manage the settings, access, and sharing of the project",
  editor: "an editor, who can work with sessions and files but cannot manage the project",
  viewer: "a viewer, who can read the project but cannot change it"
};

/** The warning before the last owner leaves or loses the role. The backend
 *  allows it (decision D13j), and an organization admin can assign an owner. */
export const NO_OWNER_WARNING =
  "The project will have no owner. An organization admin can assign one later. " +
  "Until then, nobody can change owner-only settings, such as access and sharing. " +
  "The other members keep their access.";

export function memberName(member: Pick<ProjectMember, "displayName" | "email" | "userId">): string {
  return member.displayName?.trim() || member.email?.trim() || member.userId;
}

/** True when the change takes the role of the only owner. The backend counts
 *  an owner the same way: an explicit owner who is still in the organization. */
export function leavesNoOwner(members: readonly ProjectMember[], change: MemberChange): boolean {
  if (change.member.role !== "owner" || change.role === "owner") return false;
  return members.filter((member) => member.role === "owner").length === 1;
}

export type MemberChangeNotice = {
  title: string;
  details: string[];
  /** Set when the project has no owner after the change. */
  noOwnerWarning: string | null;
  /** The access that organization sharing still gives. The backend asks for it. */
  confirmRetainedRole: "viewer" | "editor" | undefined;
  confirmLabel: string;
};

/** The text of the confirmation for one change of a member. `self` is true
 *  when the member is the person who looks at the page. */
export function describeMemberChange(
  access: Pick<ProjectAccess, "visibility" | "organizationRole" | "members">,
  change: MemberChange,
  self: boolean
): MemberChangeNotice {
  const { member, role } = change;
  const name = memberName(member);
  const noOwner = leavesNoOwner(access.members, change);
  // The same rule as the backend: sharing keeps access after a removal, or after
  // a change to viewer when the organization role is editor.
  const retained = access.visibility === "organization" && (role === null || (role === "viewer" && access.organizationRole === "editor"));
  const details: string[] = [];
  if (role === null) details.push(self ? "You lose your own role in this project." : `${name} loses their role in this project.`);
  else details.push(`${self ? "You" : name} will be ${ROLE_PHRASE[role]}.`);
  if (!noOwner && self && member.role === "owner" && role !== "owner") {
    details.push("You will no longer be able to manage this project.");
  }
  if (retained) {
    details.push(
      `Organization sharing still gives everyone in the organization ${access.organizationRole === "editor" ? "edit" : "view"} access, including ${self ? "you" : name}.`
    );
  }
  return {
    title: role === null
      ? self ? "Leave this project?" : `Remove ${name} from this project?`
      : self ? `Change your role to ${role}?` : `Change ${name} to ${role}?`,
    details,
    noOwnerWarning: noOwner ? NO_OWNER_WARNING : null,
    confirmRetainedRole: retained ? access.organizationRole : undefined,
    confirmLabel: role === null ? (self ? "Leave project" : "Remove member") : "Change role"
  };
}
