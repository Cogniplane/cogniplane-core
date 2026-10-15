import { describe, expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";
import { ProjectAccessError } from "./project-access.js";
import { ProjectStore } from "./project-store.js";

// Unit tests for ProjectStore decisions made in TypeScript: session
// assignment, archive guards, optimistic versions and audit-on-success. The
// fake answers by bound values. projectRoleSql, the idle predicate and RLS are
// proven against Postgres in src/integration/projects.integration.test.ts,
// project-capabilities.integration.test.ts and session-executions.integration.test.ts.

const T0 = "2026-10-01T00:00:00.000Z";
type Role = "owner" | "editor" | "viewer";

class ProjectWorld {
  readonly pool = new FakePool();
  roles: Record<string, Role> = { "owner-1": "owner", "editor-1": "editor", "viewer-1": "viewer" };
  archived = false;
  activeTurn = false;
  // session id -> current project and owner of a normal, active session
  sessions = new Map<string, { userId: string; projectId: string | null }>([
    ["free-1", { userId: "editor-1", projectId: null }],
    ["assigned-1", { userId: "editor-1", projectId: "project-1" }],
    ["elsewhere-1", { userId: "editor-1", projectId: "project-2" }]
  ]);
  instructionsRevision = 3;
  capability = { selection: { skillIds: ["skill-a"], connectorIds: [] } as unknown, version: 7 };
  // Simulates a role change or departure that the guarded UPDATE sees after authorization.
  updateMatches = true;
  demoteAfterRoleRead: string | null = null;
  readonly audits: { userId: unknown; type: unknown; payload: Record<string, unknown> }[] = [];
  failOn: string | null = null;

  constructor() {
    const none = { rows: [], rowCount: 0 };
    const one = (row: Record<string, unknown>) => ({ rows: [row], rowCount: 1 });
    const guarded = (row: Record<string, unknown>) => (this.updateMatches ? one(row) : none);
    this.pool
      .onQuery("SELECT project_id FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", () => one({ project_id: "project-1" }))
      .onQuery("SELECT p.archived_at, p.visibility", (_sql, [, , userId]) => {
        const role = this.roles[String(userId)] ?? null;
        if (this.demoteAfterRoleRead === userId) {
          this.roles[String(userId)] = "editor";
          this.demoteAfterRoleRead = null;
        }
        return one({ archived_at: this.archived ? T0 : null, visibility: "private", organization_role: "viewer", role });
      })
      // Anchored: guarded UPDATEs embed the same subquery in their idle predicate.
      .onQuery(/^SELECT 1 FROM session_executions/, () => (this.activeTurn ? one({}) : none))
      .onQuery("purpose = 'normal' FOR UPDATE", (_sql, [, userId, sessionId]) => {
        const session = this.sessions.get(String(sessionId));
        return session && session.userId === userId ? one({ project_id: session.projectId }) : none;
      })
      .onQuery("UPDATE sessions SET project_id", (_sql, [, userId, projectId, sessionId]) => {
        const session = this.sessions.get(String(sessionId));
        if (!session || session.userId !== userId || session.projectId !== null) return none;
        session.projectId = String(projectId);
        return one({});
      })
      .onQuery("UPDATE projects SET updated_at", () => one({}))
      .onQuery("SET archived_at", (_sql, [, , , archived]) => {
        if (!this.updateMatches) return none;
        this.archived = archived === true;
        return one({ project_id: "project-1" });
      })
      .onQuery("SET approval_mode", () => guarded({ project_id: "project-1" }))
      .onQuery("SET agent_file_mode", () => guarded({ project_id: "project-1" }))
      .onQuery("SET instructions = $4", (_sql, values) => {
        if (!this.updateMatches || values[4] !== this.instructionsRevision) return none;
        this.instructionsRevision += 1;
        return one({ instructions_revision: this.instructionsRevision });
      })
      .onQuery("SELECT capability_selection, capability_version FROM projects", () => one({
        capability_selection: this.capability.selection,
        capability_version: this.capability.version
      }))
      .onQuery("SET capability_selection", (_sql, values) => {
        if (!this.updateMatches || values[4] !== this.capability.version) return none;
        this.capability = { selection: values[3] === null ? null : JSON.parse(String(values[3])), version: this.capability.version + 1 };
        return one({ capability_version: this.capability.version });
      })
      .onQuery("INSERT INTO projects", (_sql, [, , projectId, name]) => one({
        project_id: projectId, name, instructions: "", instructions_revision: 0,
        approval_mode: "organization_default", agent_file_mode: "read-only", archived_at: null,
        created_at: T0, updated_at: T0
      }))
      .onQuery("INSERT INTO project_memberships", () => {
        if (this.failOn === "membership") throw new Error("membership insert failed");
        return one({});
      })
      .onQuery("INSERT INTO sessions", () => one({}))
      .onQuery("INSERT INTO audit_events", (_sql, values) => {
        this.audits.push({ userId: values[2], type: values[4], payload: JSON.parse(String(values[5])) });
        return one({});
      });
  }

  store() {
    return new ProjectStore(this.pool.asPool());
  }

  statements(fragment: string) {
    return this.pool.queries.filter(query => query.text.includes(fragment));
  }

  ended(): string | undefined {
    return this.pool.queries.map(query => query.text.trim()).filter(text => text === "COMMIT" || text === "ROLLBACK").at(-1);
  }
}

describe("ProjectStore.create", () => {
  test("creates the project, its owner membership and its reference session for the creator in one tenant scope", async () => {
    const world = new ProjectWorld();

    const project = await world.store().create("tenant-a", "user-1", "Launch plan");

    const [projectInsert] = world.statements("INSERT INTO projects");
    const [membership] = world.statements("INSERT INTO project_memberships");
    const [reference] = world.statements("INSERT INTO sessions");
    const projectId = projectInsert!.values[2];
    expect(projectInsert!.values).toEqual(["tenant-a", "user-1", projectId, "Launch plan"]);
    expect(membership!.values).toEqual(["tenant-a", projectId, "user-1"]);
    expect(membership!.text).toContain("'owner'");
    expect(reference!.values).toEqual(["tenant-a", "user-1", project.referenceSessionId, "Launch plan", projectId]);
    expect(reference!.text).toContain("'project_reference'");
    expect(project).toMatchObject({ projectId, name: "Launch plan", agentFileMode: "read-only", archivedAt: null });
    expect(world.statements("set_config").map(query => query.values)).toEqual([["tenant-a"]]);
    expect(world.ended()).toBe("COMMIT");
  });

  test("rolls back the project when its owner membership cannot be written", async () => {
    const world = new ProjectWorld();
    world.failOn = "membership";

    await expect(world.store().create("tenant-a", "user-1", "Launch plan")).rejects.toThrow("membership insert failed");
    expect(world.statements("INSERT INTO sessions")).toEqual([]);
    expect(world.ended()).toBe("ROLLBACK");
  });
});

describe("ProjectStore.setSession", () => {
  test("assigns an unassigned session of the editor and touches the project", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setSession("tenant-a", "editor-1", "project-1", "free-1")).toBe(true);
    expect(world.sessions.get("free-1")?.projectId).toBe("project-1");
    expect(world.statements("UPDATE projects SET updated_at").map(query => query.values)).toEqual([["tenant-a", "project-1"]]);
  });

  test("treats a repeated assignment as done and refuses to move a session out of another project", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setSession("tenant-a", "editor-1", "project-1", "assigned-1")).toBe(true);
    expect(await world.store().setSession("tenant-a", "editor-1", "project-1", "elsewhere-1")).toBe(false);
    expect(world.sessions.get("elsewhere-1")?.projectId).toBe("project-2");
    expect(world.statements("UPDATE sessions SET project_id")).toEqual([]);
  });

  test("refuses another user's session and a viewer's assignment", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setSession("tenant-a", "owner-1", "project-1", "free-1")).toBe(false);
    await expect(world.store().setSession("tenant-a", "viewer-1", "project-1", "free-1"))
      .rejects.toMatchObject({ code: "project_role_required", status: 403 });
    expect(world.sessions.get("free-1")?.projectId).toBeNull();
    expect(world.statements("UPDATE sessions SET project_id")).toEqual([]);
  });
});

describe("ProjectStore.setArchived", () => {
  test("refuses to archive while a turn is active and writes nothing", async () => {
    const world = new ProjectWorld();
    world.activeTurn = true;

    const error = await world.store().setArchived("tenant-a", "owner-1", "project-1", true).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectAccessError);
    expect(error).toMatchObject({ code: "project_busy", status: 409 });
    expect(world.statements("SET archived_at")).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.ended()).toBe("ROLLBACK");
  });

  test("restores an archived project during an active turn and audits the restore", async () => {
    const world = new ProjectWorld();
    world.archived = true;
    world.activeTurn = true;

    expect(await world.store().setArchived("tenant-a", "owner-1", "project-1", false)).toBe(true);
    expect(world.archived).toBe(false);
    expect(world.audits).toEqual([{ userId: "owner-1", type: "project_restored", payload: { projectId: "project-1" } }]);
  });

  test("archives an idle project once and writes no audit when the guarded update matches nothing", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setArchived("tenant-a", "owner-1", "project-1", true)).toBe(true);
    expect(world.audits.map(audit => audit.type)).toEqual(["project_archived"]);

    world.updateMatches = false;
    expect(await world.store().setArchived("tenant-a", "owner-1", "project-1", false)).toBe(false);
    expect(world.audits).toHaveLength(1);
  });

  test("refuses an editor", async () => {
    const world = new ProjectWorld();

    await expect(world.store().setArchived("tenant-a", "editor-1", "project-1", true))
      .rejects.toMatchObject({ code: "project_role_required", status: 403 });
    expect(world.statements("SET archived_at")).toEqual([]);
  });
});

describe("ProjectStore owner settings", () => {
  test.each([
    ["approval mode", "project_approval_mode_changed", (store: ProjectStore, userId: string) =>
      store.setApprovalMode("tenant-a", userId, "project-1", "manual"), { approvalMode: "manual" }],
    ["agent file mode", "project_agent_file_mode_changed", (store: ProjectStore, userId: string) =>
      store.setAgentFileMode("tenant-a", userId, "project-1", "read-write"), { agentFileMode: "read-write" }]
  ])("audits the %s change only when the owner's update matched", async (_label, type, change, payload) => {
    const world = new ProjectWorld();

    expect(await change(world.store(), "owner-1")).toBe(true);
    expect(world.audits).toEqual([{ userId: "owner-1", type, payload: { projectId: "project-1", ...payload } }]);

    world.updateMatches = false;
    expect(await change(world.store(), "owner-1")).toBe(false);
    expect(world.audits).toHaveLength(1);

    await expect(change(world.store(), "editor-1")).rejects.toMatchObject({ code: "project_role_required" });
    world.archived = true;
    await expect(change(world.store(), "owner-1")).rejects.toMatchObject({ code: "project_archived", status: 409 });
    expect(world.audits).toHaveLength(1);
  });
});

describe("ProjectStore.updateInstructions", () => {
  test("saves the expected revision and reports a stale revision as false", async () => {
    const world = new ProjectWorld();

    expect(await world.store().updateInstructions("tenant-a", "owner-1", "project-1", "Be brief.", 3)).toBe(true);
    expect(await world.store().updateInstructions("tenant-a", "owner-1", "project-1", "Be briefer.", 3)).toBe(false);
    expect(world.instructionsRevision).toBe(4);
  });

  test("reports a lost owner role after authorization as an access error, not a stale revision", async () => {
    const world = new ProjectWorld();
    // The owner is demoted right after the first role check, so the guarded
    // UPDATE matches nothing even though the revision is current.
    world.demoteAfterRoleRead = "owner-1";
    world.updateMatches = false;

    await expect(world.store().updateInstructions("tenant-a", "owner-1", "project-1", "Be brief.", 3))
      .rejects.toMatchObject({ code: "project_role_required", status: 403 });
    expect(world.instructionsRevision).toBe(3);
  });
});

describe("ProjectStore capabilities", () => {
  const selection = { skillIds: ["skill-a", "skill-b"], connectorIds: [] };

  test("saves a selection at the expected version and audits the new version", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setCapabilities("tenant-a", "owner-1", "project-1", { selection, version: 7 })).toBe(true);
    expect(world.capability).toEqual({ selection, version: 8 });
    expect(world.audits).toEqual([{
      userId: "owner-1",
      type: "project_capabilities_changed",
      payload: { projectId: "project-1", selection, version: 8 }
    }]);
  });

  test("refuses a stale version or a newly added capability that is unavailable, without writing", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setCapabilities("tenant-a", "owner-1", "project-1", { selection, version: 6 })).toBe(false);
    expect(await world.store().setCapabilities("tenant-a", "owner-1", "project-1", { selection, version: 7 },
      { skillIds: ["skill-a"], connectorIds: [] })).toBe(false);
    expect(world.statements("SET capability_selection")).toEqual([]);
    expect(world.audits).toEqual([]);
  });

  test("keeps a saved capability that is no longer available", async () => {
    const world = new ProjectWorld();

    expect(await world.store().setCapabilities("tenant-a", "owner-1", "project-1",
      { selection: { skillIds: ["skill-a"], connectorIds: [] }, version: 7 }, { skillIds: [], connectorIds: [] })).toBe(true);
  });

  test("refuses an editor and an archived project", async () => {
    const world = new ProjectWorld();

    await expect(world.store().setCapabilities("tenant-a", "editor-1", "project-1", { selection, version: 7 }))
      .rejects.toMatchObject({ code: "project_role_required" });
    world.archived = true;
    await expect(world.store().setCapabilities("tenant-a", "owner-1", "project-1", { selection, version: 7 }))
      .rejects.toMatchObject({ code: "project_archived" });
    expect(world.capability.version).toBe(7);
  });

  test("returns false without an audit when the guarded update finds active work", async () => {
    const world = new ProjectWorld();
    world.updateMatches = false;

    expect(await world.store().setCapabilities("tenant-a", "owner-1", "project-1", { selection, version: 7 })).toBe(false);
    expect(world.audits).toEqual([]);
    expect(world.statements("SELECT p.archived_at, p.visibility")).toHaveLength(2);
  });

  test("hides capabilities from a user without a project role and reports edit rights", async () => {
    const pool = new FakePool().onQuery("SELECT p.capability_selection", (_sql, [, userId]) => userId === "owner-1"
      ? { rows: [{ capability_selection: null, capability_version: "4", can_edit: true }], rowCount: 1 }
      : userId === "viewer-1"
        ? { rows: [{ capability_selection: { skillIds: [], connectorIds: ["c1"] }, capability_version: 4, can_edit: "true" }], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    const store = new ProjectStore(pool.asPool());

    expect(await store.getCapabilities("tenant-a", "owner-1", "project-1")).toEqual({ selection: null, version: 4, canEdit: true });
    expect(await store.getCapabilities("tenant-a", "viewer-1", "project-1"))
      .toEqual({ selection: { skillIds: [], connectorIds: ["c1"] }, version: 4, canEdit: false });
    await expect(store.getCapabilities("tenant-a", "outsider-1", "project-1"))
      .rejects.toMatchObject({ code: "project_not_found", status: 404 });
  });
});

describe("ProjectStore reads", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    project_id: "project-1", name: "Launch", instructions: null, instructions_revision: null,
    approval_mode: "surprise", agent_file_mode: "write-everything", archived_at: null,
    created_at: T0, updated_at: T0, reference_session_id: "reference-1", ...overrides
  });

  test("maps unknown modes to the organization default and read-only file access", async () => {
    const pool = new FakePool().onQuery("FROM projects p", () => ({
      rows: [row({ can_manage: "true", can_edit: true })],
      rowCount: 1
    }));

    const project = await new ProjectStore(pool.asPool()).getReadable("tenant-a", "editor-1", "project-1");

    expect(project).toMatchObject({
      approvalMode: "organization_default",
      agentFileMode: "read-only",
      instructions: "",
      instructionsRevision: 0,
      canManage: false,
      canEdit: true
    });
  });

  test("searches by a trimmed term with LIKE wildcards escaped", async () => {
    const pool = new FakePool().onQuery("FROM projects p", () => ({ rows: [row({ agent_file_mode: "create-only" })], rowCount: 1 }));
    const store = new ProjectStore(pool.asPool());

    expect((await store.list("tenant-a", "user-1", { q: "  50%_off\\  " }))[0]?.agentFileMode).toBe("create-only");
    await store.list("tenant-a", "user-1", { archived: true, q: "   " });

    const [search, blank] = pool.queries.filter(query => query.text.includes("FROM projects p"));
    expect(search!.values).toEqual(["tenant-a", "user-1", false, "%50\\%\\_off\\\\%"]);
    expect(blank!.values).toEqual(["tenant-a", "user-1", true]);
    expect(blank!.text).not.toContain("ILIKE");
  });

  test("returns null for a project the user cannot read, own or edit", async () => {
    const pool = new FakePool().onQuery("FROM projects p", () => ({ rows: [], rowCount: 0 }));
    const store = new ProjectStore(pool.asPool());

    expect(await store.getReadable("tenant-a", "user-1", "project-1")).toBeNull();
    expect(await store.getOwned("tenant-a", "user-1", "project-1")).toBeNull();
    expect(await store.getEditable("tenant-a", "user-1", "project-1")).toBeNull();
    expect(await store.getInstructionsStatus("tenant-a", "user-1", "project-1")).toBeNull();
  });
});
