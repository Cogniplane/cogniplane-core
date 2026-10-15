import { describe, expect, it } from "vitest";

import {
  NO_OWNER_WARNING,
  describeMemberChange,
  leavesNoOwner,
  memberName,
  type ProjectAccess,
  type ProjectMember
} from "./project-members.logic";

const member = (userId: string, role: ProjectMember["role"], displayName: string | null = userId): ProjectMember =>
  ({ userId, role, displayName, email: `${userId}@example.test` });
const access = (members: ProjectMember[], visibility: ProjectAccess["visibility"] = "private",
  organizationRole: ProjectAccess["organizationRole"] = "viewer"): ProjectAccess => ({ visibility, organizationRole, members });

describe("leavesNoOwner", () => {
  const sole = [member("ana", "owner"), member("bo", "editor")];
  const two = [member("ana", "owner"), member("cy", "owner"), member("bo", "editor")];

  it("is true when the only owner leaves or is demoted", () => {
    expect(leavesNoOwner(sole, { member: sole[0]!, role: null })).toBe(true);
    expect(leavesNoOwner(sole, { member: sole[0]!, role: "editor" })).toBe(true);
    expect(leavesNoOwner(sole, { member: sole[0]!, role: "viewer" })).toBe(true);
  });

  it("is false while another owner stays, or the owner keeps the role", () => {
    expect(leavesNoOwner(two, { member: two[0]!, role: null })).toBe(false);
    expect(leavesNoOwner(two, { member: two[0]!, role: "viewer" })).toBe(false);
    expect(leavesNoOwner(sole, { member: sole[0]!, role: "owner" })).toBe(false);
  });

  it("is false for a change to a member who is not an owner", () => {
    expect(leavesNoOwner(sole, { member: sole[1]!, role: null })).toBe(false);
    expect(leavesNoOwner(sole, { member: sole[1]!, role: "owner" })).toBe(false);
  });

  it("does not count a project with no owner as a loss", () => {
    const none = [member("bo", "editor")];
    expect(leavesNoOwner(none, { member: none[0]!, role: null })).toBe(false);
  });
});

describe("describeMemberChange", () => {
  it("warns that the project will have no owner when the only owner leaves", () => {
    const members = [member("ana", "owner", "Ana"), member("bo", "editor")];
    const notice = describeMemberChange(access(members), { member: members[0]!, role: null }, true);

    expect(notice.title).toBe("Leave this project?");
    expect(notice.noOwnerWarning).toBe(NO_OWNER_WARNING);
    expect(NO_OWNER_WARNING).toContain("The project will have no owner. An organization admin can assign one later.");
    expect(notice.confirmLabel).toBe("Leave project");
    expect(notice.details).toEqual(["You lose your own role in this project."]);
  });

  it("warns when the only owner is demoted", () => {
    const members = [member("ana", "owner", "Ana")];
    const notice = describeMemberChange(access(members), { member: members[0]!, role: "editor" }, true);

    expect(notice.title).toBe("Change your role to editor?");
    expect(notice.noOwnerWarning).toBe(NO_OWNER_WARNING);
    expect(notice.details[0]).toBe("You will be an editor, who can work with sessions and files but cannot manage the project.");
  });

  it("does not warn about a missing owner when another owner stays, and says what the person loses", () => {
    const members = [member("ana", "owner", "Ana"), member("cy", "owner", "Cy")];
    const notice = describeMemberChange(access(members), { member: members[0]!, role: "viewer" }, true);

    expect(notice.noOwnerWarning).toBeNull();
    expect(notice.details).toContain("You will no longer be able to manage this project.");
  });

  it("names another member and warns about nothing for a member who is not an owner", () => {
    const members = [member("ana", "owner", "Ana"), member("bo", "editor", "Bo")];
    const remove = describeMemberChange(access(members), { member: members[1]!, role: null }, false);
    const promote = describeMemberChange(access(members), { member: members[1]!, role: "owner" }, false);

    expect(remove).toMatchObject({ title: "Remove Bo from this project?", noOwnerWarning: null, confirmLabel: "Remove member" });
    expect(remove.details).toEqual(["Bo loses their role in this project."]);
    expect(promote).toMatchObject({ title: "Change Bo to owner?", noOwnerWarning: null, confirmLabel: "Change role" });
    expect(promote.details[0]).toContain("Bo will be an owner");
  });

  it("asks to confirm the access that organization sharing keeps, with the rule of the backend", () => {
    const members = [member("ana", "owner", "Ana"), member("bo", "editor", "Bo")];
    const bo = members[1]!;
    const retained = (visibility: ProjectAccess["visibility"], organizationRole: ProjectAccess["organizationRole"], role: ProjectMember["role"] | null) =>
      describeMemberChange(access(members, visibility, organizationRole), { member: bo, role }, false).confirmRetainedRole;

    expect(retained("organization", "viewer", null)).toBe("viewer");
    expect(retained("organization", "editor", null)).toBe("editor");
    expect(retained("organization", "editor", "viewer")).toBe("editor");
    expect(retained("organization", "viewer", "viewer")).toBeUndefined();
    expect(retained("organization", "editor", "owner")).toBeUndefined();
    expect(retained("private", "editor", null)).toBeUndefined();
    expect(retained("private", "editor", "viewer")).toBeUndefined();

    const notice = describeMemberChange(access(members, "organization", "editor"), { member: bo, role: null }, false);
    expect(notice.details).toContain("Organization sharing still gives everyone in the organization edit access, including Bo.");
  });
});

describe("memberName", () => {
  it("falls back from name to email to ID", () => {
    expect(memberName({ userId: "u1", displayName: " Ana ", email: "a@example.test" })).toBe("Ana");
    expect(memberName({ userId: "u1", displayName: null, email: "a@example.test" })).toBe("a@example.test");
    expect(memberName({ userId: "u1", displayName: null, email: null })).toBe("u1");
  });
});
