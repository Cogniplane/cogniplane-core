import { describe, expect, it } from "vitest";

import { ApiError } from "../../../lib/api-client";
import {
  displayName,
  memberActionError,
  removeLockReason,
  roleChangeEffects,
  roleChoices,
  roleLockReason,
  type MemberRole
} from "./person-access.logic";

const owner = { userId: "owner-1", role: "owner" as const };
const admin = { userId: "admin-1", role: "admin" as const };
const target = (role: MemberRole, userId = "target-1") => ({ userId, role });

// Mirrors the rules in apps/backend/src/routes/tenant.ts. If the backend
// rules change, this matrix must change with them.
describe("role choices", () => {
  it.each([
    ["owner", "member", ["admin", "owner"]],
    ["owner", "admin", ["member", "owner"]],
    ["owner", "owner", []],
    ["admin", "member", []],
    ["admin", "admin", []],
    ["admin", "owner", []]
  ] as const)("%s actor, %s target", (actorRole, targetRole, expected) => {
    const actor = actorRole === "owner" ? owner : admin;
    expect(roleChoices(actor, target(targetRole))).toEqual(expected);
  });

  it("locks the actor's own role", () => {
    expect(roleChoices(owner, target("owner", owner.userId))).toEqual([]);
    expect(roleLockReason(owner, target("owner", owner.userId))).toBe("You cannot change your own role.");
  });

  it("explains why the role is locked", () => {
    expect(roleLockReason(admin, target("member"))).toBe("Only owners can change roles.");
    expect(roleLockReason(owner, target("owner"))).toMatch(/No one can demote an owner/);
  });
});

describe("removal", () => {
  it.each([
    [owner, "member", null],
    [owner, "admin", null],
    // Only an owner can remove an admin, as the backend enforces.
    [admin, "admin", "Only owners can remove an admin."],
    [admin, "member", null],
    [owner, "owner", "Owners cannot be removed."],
    [admin, "owner", "Owners cannot be removed."]
  ] as const)("%o removing %s", (actor, targetRole, expected) => {
    expect(removeLockReason(actor, target(targetRole))).toBe(expected);
  });

  it("maps the backend admin-removal refusal to its message", () => {
    const error = new ApiError({ status: 403, code: "only_owner_can_remove_admin", method: "DELETE", path: "/x", message: "forbidden" });
    expect(memberActionError(error, "fallback")).toBe("Only owners can remove an admin.");
  });

  it("forbids removing yourself", () => {
    expect(removeLockReason(admin, target("admin", admin.userId))).toBe("You cannot remove yourself.");
  });
});

describe("role change effects", () => {
  it("states that owner elevation cannot be undone", () => {
    expect(roleChangeEffects("admin", "owner", "Dana").join(" ")).toMatch(/cannot undo this.*demote or remove an owner/i);
  });

  it("states that only an owner can change an admin later", () => {
    expect(roleChangeEffects("member", "admin", "Dana")).toContain("Only an owner can change this role again.");
  });

  it("describes admin demotion", () => {
    expect(roleChangeEffects("admin", "member", "Dana")[0]).toBe("Dana loses access to the admin area.");
  });
});

describe("display", () => {
  it("falls back from name to email to ID", () => {
    expect(displayName({ displayName: " Dana ", email: "d@x.test", userId: "u" })).toBe("Dana");
    expect(displayName({ displayName: null, email: "d@x.test", userId: "u" })).toBe("d@x.test");
    expect(displayName({ displayName: "  ", email: null, userId: "u" })).toBe("u");
  });

  it("maps backend error codes to plain messages", () => {
    const error = new ApiError({ status: 403, code: "cannot_demote_owner", method: "PUT", path: "/x", message: "cannot_demote_owner" });
    expect(memberActionError(error, "fallback")).toBe("An owner cannot be demoted.");
    const unknown = new ApiError({ status: 403, code: "other", method: "PUT", path: "/x", message: "other" });
    expect(memberActionError(unknown, "fallback")).toBe("You do not have permission to do this.");
  });
});
