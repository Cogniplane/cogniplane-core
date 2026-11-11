import { describe, expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";
import { ProjectAccessError } from "./project-access.js";
import { ProjectMemberStore } from "./project-member-store.js";

// Unit tests for the membership decisions the store makes in TypeScript: who
// may change a role, which changes need confirmation, and that a refusal
// writes neither a membership nor an audit event. The fake keeps a small
// project model and answers by bound values. projectRoleSql, RLS and the real
// transaction are proven against Postgres in
// src/integration/project-memberships.integration.test.ts and
// project-member-routes.integration.test.ts.

type Role = "owner" | "editor" | "viewer";
type Project = {
  exists: boolean;
  archived: boolean;
  visibility: "private" | "organization";
  organizationRole: "viewer" | "editor";
  explicit: Map<string, Role>;
};

const actor = { tenantId: "tenant-a", projectId: "project-1", userId: "owner-1" };
const privateViewer = { visibility: "private", organizationRole: "viewer" } as const;
const sharedViewer = { visibility: "organization", organizationRole: "viewer" } as const;
const sharedEditor = { visibility: "organization", organizationRole: "editor" } as const;

class ProjectWorld {
  readonly pool = new FakePool();
  readonly organization = new Map<string, "owner" | "admin" | "member">([
    ["owner-1", "member"], ["editor-1", "member"], ["viewer-1", "member"], ["member-1", "member"], ["admin-1", "admin"]
  ]);
  readonly project: Project = {
    exists: true,
    archived: false,
    visibility: "private",
    organizationRole: "viewer",
    explicit: new Map<string, Role>([["owner-1", "owner"], ["editor-1", "editor"], ["viewer-1", "viewer"]])
  };
  readonly audits: { userId: unknown; type: unknown; payload: Record<string, unknown> }[] = [];

  constructor() {
    const none = { rows: [], rowCount: 0 };
    const one = (row: Record<string, unknown>) => ({ rows: [row], rowCount: 1 });
    this.pool
      .onQuery("role IN ('owner','admin') FOR SHARE", (_sql, [, userId]) => {
        const role = this.organization.get(String(userId));
        return role === "owner" || role === "admin" ? one({ user_id: userId, role }) : none;
      })
      .onQuery("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE", (_sql, [, userId]) =>
        this.organization.has(String(userId)) ? one({ user_id: userId }) : none)
      .onQuery("SELECT project_id FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", () =>
        this.project.exists ? one({ project_id: actor.projectId }) : none)
      .onQuery("SELECT p.archived_at, p.visibility", (_sql, [, , userId]) => this.project.exists
        ? one({
          archived_at: this.project.archived ? "2026-10-01T00:00:00.000Z" : null,
          visibility: this.project.visibility,
          organization_role: this.project.organizationRole,
          role: this.effectiveRole(String(userId))
        })
        : none)
      .onQuery("SELECT role FROM project_memberships", (_sql, [, , userId]) => {
        const role = this.project.explicit.get(String(userId));
        return role ? one({ role }) : none;
      })
      .onQuery("SELECT pm.user_id FROM project_memberships pm", () => {
        const rows = [...this.project.explicit]
          .filter(([userId, role]) => role === "owner" && this.organization.has(userId))
          .map(([userId]) => ({ user_id: userId }));
        return { rows, rowCount: rows.length };
      })
      .onQuery("SELECT pm.user_id, pm.role, u.display_name", () => ({
        rows: [...this.project.explicit].map(([userId, role]) => ({ user_id: userId, role, display_name: null, email: null })),
        rowCount: this.project.explicit.size
      }))
      .onQuery("SELECT p.project_id, p.name FROM projects p", () => one({ project_id: "project-9", name: "Ownerless" }))
      .onQuery("UPDATE projects SET visibility", (_sql, [, , visibility, organizationRole]) => {
        this.project.visibility = visibility as Project["visibility"];
        this.project.organizationRole = organizationRole as Project["organizationRole"];
        return one({});
      })
      .onQuery("DELETE FROM project_memberships", (_sql, [, , userId]) => {
        this.project.explicit.delete(String(userId));
        return one({});
      })
      .onQuery("INSERT INTO project_memberships", (sql, [, , userId, role]) => {
        this.project.explicit.set(String(userId), (sql.includes("'owner')") ? "owner" : role) as Role);
        return one({});
      })
      .onQuery("AS role FROM projects p", (_sql, [, , userId]) => one({ role: this.effectiveRole(String(userId)) }))
      .onQuery("INSERT INTO audit_events", (_sql, values) => {
        this.audits.push({ userId: values[2], type: values[4], payload: JSON.parse(String(values[5])) });
        return one({});
      });
  }

  // Test model of the effective role: the higher of the explicit role and
  // organization sharing, and nothing after organization departure.
  effectiveRole(userId: string): Role | null {
    if (!this.organization.has(userId)) return null;
    const explicit = this.project.explicit.get(userId);
    const shared = this.project.visibility === "organization" ? this.project.organizationRole : null;
    if (explicit === "owner") return "owner";
    if (explicit === "editor" || shared === "editor") return "editor";
    if (explicit === "viewer" || shared === "viewer") return "viewer";
    return null;
  }

  store() {
    return new ProjectMemberStore(this.pool.asPool());
  }

  writes(): string[] {
    return this.pool.queries.map(query => query.text.trim())
      .filter(text => /^(INSERT|UPDATE|DELETE)/.test(text));
  }

  ended(): string | undefined {
    return this.pool.queries.map(query => query.text.trim()).filter(text => text === "COMMIT" || text === "ROLLBACK").at(-1);
  }
}

async function refusedWithoutWrite(world: ProjectWorld, action: Promise<unknown>) {
  const error = await action.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProjectAccessError);
  expect(world.writes()).toEqual([]);
  expect(world.audits).toEqual([]);
  expect(world.ended()).toBe("ROLLBACK");
  return error;
}

describe("ProjectMemberStore input validation", () => {
  test("rejects an invalid sharing setting or role before it opens a transaction", async () => {
    const world = new ProjectWorld();

    await expect(world.store().setSharing(actor, { visibility: "public" as "private", organizationRole: "viewer", expected: privateViewer }))
      .rejects.toMatchObject({ code: "invalid_project_sharing", status: 400 });
    await expect(world.store().setMember(actor, "member-1", "admin" as "owner"))
      .rejects.toMatchObject({ code: "invalid_project_role", status: 400 });
    expect(world.pool.queries).toEqual([]);
  });
});

describe("ProjectMemberStore lock order", () => {
  // The role query alone also rejects a departed actor, so this checks the
  // order only: the actor's organization membership is held FOR SHARE before
  // the project row lock. The blocking effect itself needs Postgres.
  test.each([
    ["setSharing", (store: ProjectMemberStore) => store.setSharing(actor, { ...privateViewer, expected: privateViewer })],
    ["setMember", (store: ProjectMemberStore) => store.setMember(actor, "member-1", "viewer")]
  ])("%s locks the actor's organization membership before the project", async (_label, change) => {
    const world = new ProjectWorld();

    await change(world.store());

    const texts = world.pool.queries.map(query => query.text);
    const membershipLock = world.pool.queries.findIndex(query =>
      query.text.includes("FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE"));
    expect(world.pool.queries[membershipLock]?.values).toEqual(["tenant-a", "owner-1"]);
    expect(membershipLock).toBeGreaterThan(texts.findIndex(text => text.includes("set_config")));
    expect(membershipLock).toBeLessThan(texts.findIndex(text => text.includes("FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE")));
  });
});

describe("ProjectMemberStore.setSharing", () => {
  test("requires audience confirmation before it shares a private project with the organization", async () => {
    const world = new ProjectWorld();

    const error = await refusedWithoutWrite(world,
      world.store().setSharing(actor, { ...sharedViewer, expected: privateViewer }));
    expect(error).toMatchObject({ code: "project_audience_confirmation_required", status: 409 });

    await world.store().setSharing(actor, { ...sharedViewer, confirmAudience: true, expected: privateViewer });
    expect(world.project).toMatchObject({ visibility: "organization", organizationRole: "viewer" });
    expect(world.audits).toEqual([{
      userId: "owner-1",
      type: "project_sharing_changed",
      payload: {
        projectId: "project-1",
        previousVisibility: "private",
        previousOrganizationRole: "viewer",
        visibility: "organization",
        organizationRole: "viewer"
      }
    }]);
    expect(world.ended()).toBe("COMMIT");
  });

  test("asks again when an organization-shared project would grant a wider role", async () => {
    const world = new ProjectWorld();
    world.project.visibility = "organization";

    await refusedWithoutWrite(world, world.store().setSharing(actor, { ...sharedEditor, expected: sharedViewer }));
  });

  test("makes a project private again without confirmation", async () => {
    const world = new ProjectWorld();
    world.project.visibility = "organization";

    await world.store().setSharing(actor, { ...privateViewer, expected: sharedViewer });
    expect(world.project.visibility).toBe("private");
  });

  // Issue #42: the owner confirms a change from the access they loaded. When
  // another owner changed it since, the confirmation describes the wrong change.
  test.each([
    ["the project became private", privateViewer, { ...sharedEditor, confirmAudience: true }],
    ["the organization role changed", sharedEditor, { ...sharedEditor, confirmAudience: true }],
    ["the organization role changed before a members-only save", sharedEditor, privateViewer]
  ] as const)("refuses a change made from stale access when %s", async (_label, saved, change) => {
    const world = new ProjectWorld();
    Object.assign(world.project, saved);

    const error = await refusedWithoutWrite(world, world.store().setSharing(actor, { ...change, expected: sharedViewer }));
    expect(error).toMatchObject({ code: "project_sharing_conflict", status: 409 });
    expect(world.project).toMatchObject(saved);
  });

  test("refuses a change that does not name the saved access it was made from", async () => {
    const world = new ProjectWorld();
    world.project.visibility = "private";
    const unnamed = { ...sharedEditor, confirmAudience: true } as unknown as Parameters<ProjectMemberStore["setSharing"]>[1];

    await expect(world.store().setSharing(actor, unnamed)).rejects.toMatchObject({ code: "invalid_project_sharing", status: 400 });
    expect(world.pool.queries).toEqual([]);
    expect(world.project).toMatchObject(privateViewer);
  });

  // The role check runs before the saved-access check, so a conflict never
  // tells a person who is not an owner what the saved access is.
  test.each([
    ["an editor", "editor-1", { code: "project_role_required", status: 403 }],
    ["a former organization member", "gone-1", { code: "project_not_found", status: 404 }]
  ])("refuses %s, also with stale access", async (_label, userId, expected) => {
    for (const named of [privateViewer, sharedEditor]) {
      const world = new ProjectWorld();
      world.project.explicit.set("gone-1", "owner");

      const error = await refusedWithoutWrite(world, world.store().setSharing({ ...actor, userId },
        { ...privateViewer, expected: named }));
      expect(error).toMatchObject(expected);
    }
  });

  test("refuses a sharing change on an archived project", async () => {
    const world = new ProjectWorld();
    world.project.archived = true;

    const error = await refusedWithoutWrite(world, world.store().setSharing(actor, { ...privateViewer, expected: privateViewer }));
    expect(error).toMatchObject({ code: "project_archived", status: 409 });
  });
});

describe("ProjectMemberStore.setMember", () => {
  test("lets an owner grant a role to an organization member and audits the actor and effective role", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setMember(actor, "member-1", "editor")).toEqual({ role: "editor", effectiveRole: "editor" });
    expect(world.project.explicit.get("member-1")).toBe("editor");
    expect(world.pool.queries.find(query => query.text.includes("INSERT INTO project_memberships"))?.values)
      .toEqual(["tenant-a", "project-1", "member-1", "editor"]);
    expect(world.audits).toEqual([{
      userId: "owner-1",
      type: "project_member_changed",
      payload: { projectId: "project-1", memberUserId: "member-1", previousRole: null, role: "editor", effectiveRole: "editor" }
    }]);
  });

  test("refuses an editor who tries to change another member", async () => {
    const world = new ProjectWorld();

    const error = await refusedWithoutWrite(world, world.store().setMember({ ...actor, userId: "editor-1" }, "viewer-1", null));
    expect(error).toMatchObject({ code: "project_role_required", status: 403 });
  });

  test("lets a viewer remove only an explicit membership of their own", async () => {
    const world = new ProjectWorld();
    const viewer = { ...actor, userId: "viewer-1" };

    expect(await world.store().setMember(viewer, "viewer-1", null)).toEqual({ role: null, effectiveRole: null });
    expect(world.project.explicit.has("viewer-1")).toBe(false);

    const again = new ProjectWorld();
    again.project.explicit.delete("viewer-1");
    again.project.visibility = "organization";
    const error = await refusedWithoutWrite(again, again.store().setMember(viewer, "viewer-1", null));
    expect(error).toMatchObject({ code: "project_no_explicit_membership", status: 409 });
  });

  test("refuses a grant to a user outside the organization but allows removing a departed member", async () => {
    const world = new ProjectWorld();

    const error = await refusedWithoutWrite(world, world.store().setMember(actor, "outsider-1", "viewer"));
    expect(error).toMatchObject({ code: "organization_member_not_found", status: 404 });

    const departed = new ProjectWorld();
    departed.organization.delete("editor-1");
    expect(await departed.store().setMember(actor, "editor-1", null)).toEqual({ role: null, effectiveRole: null });
  });

  test("requires the caller to confirm the organization role that remains after a removal or demotion", async () => {
    const world = new ProjectWorld();
    world.project.visibility = "organization";
    world.project.organizationRole = "editor";

    await refusedWithoutWrite(world, world.store().setMember(actor, "editor-1", "viewer"));
    await refusedWithoutWrite(world, world.store().setMember(actor, "editor-1", "viewer", { confirmRetainedRole: "viewer" }));
    expect(await world.store().setMember(actor, "editor-1", "viewer", { confirmRetainedRole: "editor" }))
      .toEqual({ role: "viewer", effectiveRole: "editor" });
  });

  test("allows a reduction but refuses a wider grant in an archived project", async () => {
    const world = new ProjectWorld();
    world.project.archived = true;

    const error = await refusedWithoutWrite(world, world.store().setMember(actor, "viewer-1", "editor"));
    expect(error).toMatchObject({ code: "project_archived", status: 409 });

    expect(await world.store().setMember(actor, "editor-1", "viewer")).toEqual({ role: "viewer", effectiveRole: "viewer" });
  });
});

// Issue #42: the page warned before the last owner left only when its cached
// member list held one owner. The store counts the owners again after the
// project lock and asks for `confirmNoOwner` when no owner stays.
describe("ProjectMemberStore.setMember without an owner after the change", () => {
  test.each([
    ["leaves", null],
    ["becomes an editor", "editor"],
    ["becomes a viewer", "viewer"]
  ] as const)("asks to confirm when the only owner %s, then makes the confirmed change", async (_label, role) => {
    const world = new ProjectWorld();

    const error = await refusedWithoutWrite(world, world.store().setMember(actor, "owner-1", role));
    expect(error).toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
    expect(world.project.explicit.get("owner-1")).toBe("owner");

    expect(await world.store().setMember(actor, "owner-1", role, { confirmNoOwner: true })).toMatchObject({ role });
    expect(world.project.explicit.get("owner-1")).toBe(role ?? undefined);
    expect(world.audits).toEqual([{
      userId: "owner-1",
      type: "project_member_changed",
      payload: { projectId: "project-1", memberUserId: "owner-1", previousRole: "owner", role, effectiveRole: role }
    }]);
    expect(world.ended()).toBe("COMMIT");
  });

  test("counts the owners after the project lock, and holds their organization membership", async () => {
    const world = new ProjectWorld();

    await world.store().setMember(actor, "owner-1", null).catch(() => undefined);

    const texts = world.pool.queries.map(query => query.text);
    const owners = texts.findIndex(text => text.includes("FROM project_memberships pm") && text.includes("pm.role='owner'"));
    expect(owners).toBeGreaterThan(texts.findIndex(text => text.includes("FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE")));
    expect(texts[owners]).toContain("FOR KEY SHARE OF tm");
    expect(world.pool.queries[owners]?.values).toEqual(["tenant-a", "project-1"]);
  });

  test("needs no confirmation while another owner stays", async () => {
    const world = new ProjectWorld();
    world.project.explicit.set("member-1", "owner");

    expect(await world.store().setMember(actor, "owner-1", null)).toEqual({ role: null, effectiveRole: null });
    expect(world.project.explicit.get("member-1")).toBe("owner");
  });

  test("does not count an owner who left the organization", async () => {
    const world = new ProjectWorld();
    world.project.explicit.set("gone-1", "owner");

    const error = await refusedWithoutWrite(world, world.store().setMember(actor, "owner-1", "viewer"));
    expect(error).toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
  });

  test("needs no confirmation to remove an owner who left the organization, or a member who is not an owner", async () => {
    const world = new ProjectWorld();
    world.project.explicit.set("gone-1", "owner");

    expect(await world.store().setMember(actor, "gone-1", null)).toEqual({ role: null, effectiveRole: null });
    expect(await world.store().setMember(actor, "editor-1", null)).toEqual({ role: null, effectiveRole: null });
    expect(await world.store().setMember({ ...actor, userId: "viewer-1" }, "viewer-1", null)).toEqual({ role: null, effectiveRole: null });
  });

  // The role check runs first, so the refusal does not tell a person who is
  // not an owner how many owners the project has.
  test.each([
    ["an editor", "editor-1", { code: "project_role_required", status: 403 }],
    ["a former organization member", "gone-1", { code: "project_not_found", status: 404 }]
  ])("refuses %s who removes the only owner, with or without the confirmation", async (_label, userId, expected) => {
    for (const confirmNoOwner of [false, true]) {
      const world = new ProjectWorld();
      world.project.explicit.set("gone-1", "owner");

      const error = await refusedWithoutWrite(world, world.store().setMember({ ...actor, userId }, "owner-1", null, { confirmNoOwner }));
      expect(error).toMatchObject(expected);
      expect(world.project.explicit.get("owner-1")).toBe("owner");
    }
  });

  test("asks for the retained organization role first, then for the missing owner", async () => {
    const world = new ProjectWorld();
    world.project.visibility = "organization";
    world.project.organizationRole = "editor";

    const retained = await refusedWithoutWrite(world, world.store().setMember(actor, "owner-1", null, { confirmNoOwner: true }));
    expect(retained).toMatchObject({ code: "project_organization_access_retained", status: 409 });
    const noOwner = await refusedWithoutWrite(world, world.store().setMember(actor, "owner-1", null, { confirmRetainedRole: "editor" }));
    expect(noOwner).toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });

    expect(await world.store().setMember(actor, "owner-1", null, { confirmRetainedRole: "editor", confirmNoOwner: true }))
      .toEqual({ role: null, effectiveRole: "editor" });
  });

  test("asks to confirm in an archived project too, where a reduction is allowed", async () => {
    const world = new ProjectWorld();
    world.project.archived = true;

    const error = await refusedWithoutWrite(world, world.store().setMember(actor, "owner-1", "viewer"));
    expect(error).toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
    expect(await world.store().setMember(actor, "owner-1", "viewer", { confirmNoOwner: true }))
      .toEqual({ role: "viewer", effectiveRole: "viewer" });
  });
});

describe("ProjectMemberStore owner recovery", () => {
  test.each([
    ["a non-administrator", (world: ProjectWorld) => world.project.explicit.delete("owner-1"), "owner-1",
      { code: "organization_admin_required", status: 403 }],
    ["a missing project", (world: ProjectWorld) => { world.project.exists = false; }, "admin-1",
      { code: "project_not_found", status: 404 }],
    ["a project that still has an owner", () => undefined, "admin-1", { code: "project_has_owner", status: 409 }]
  ])("refuses recovery for %s", async (_label, arrange, userId, expected) => {
    const world = new ProjectWorld();
    arrange(world);

    const error = await refusedWithoutWrite(world, world.store().recoverOwner({ ...actor, userId }, "member-1"));
    expect(error).toMatchObject(expected);
  });

  test("refuses a recovery target outside the organization", async () => {
    const world = new ProjectWorld();
    world.project.explicit.delete("owner-1");

    const error = await refusedWithoutWrite(world, world.store().recoverOwner({ ...actor, userId: "admin-1" }, "outsider-1"));
    expect(error).toMatchObject({ code: "organization_member_not_found", status: 404 });
  });

  test("lets an organization administrator assign an owner to an ownerless project with an audit event", async () => {
    const world = new ProjectWorld();
    // The only explicit owner left the organization.
    world.organization.delete("owner-1");

    await world.store().recoverOwner({ ...actor, userId: "admin-1" }, "member-1");

    expect(world.project.explicit.get("member-1")).toBe("owner");
    expect(world.audits).toEqual([{
      userId: "admin-1",
      type: "project_owner_recovered",
      payload: { projectId: "project-1", memberUserId: "member-1" }
    }]);
    expect(world.ended()).toBe("COMMIT");
  });

  test("lists ownerless projects only for an organization administrator", async () => {
    const world = new ProjectWorld();

    await expect(world.store().listOwnerless("tenant-a", "member-1"))
      .rejects.toMatchObject({ code: "organization_admin_required", status: 403 });
    expect(await world.store().listOwnerless("tenant-a", "admin-1")).toEqual([{ projectId: "project-9", name: "Ownerless" }]);
  });
});

describe("ProjectMemberStore.list", () => {
  test("shows members to an owner and refuses an editor", async () => {
    const world = new ProjectWorld();

    const listed = await world.store().list(actor);
    expect(listed.visibility).toBe("private");
    expect(listed.members.map(member => [member.userId, member.role])).toEqual([
      ["owner-1", "owner"], ["editor-1", "editor"], ["viewer-1", "viewer"]
    ]);
    await expect(world.store().list({ ...actor, userId: "editor-1" })).rejects.toMatchObject({ code: "project_role_required" });
  });
});
