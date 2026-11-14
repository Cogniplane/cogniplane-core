// A governed change and its audit event commit together, against a real
// Postgres with the production roles. Each test makes the audit insert fail
// inside Postgres (support/audit-faults.ts) and checks that the change rolled
// back, then removes the fault and checks that the change and its event commit.

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";

import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { DataRouteControl } from "../services/data-route-control.js";
import { MailOutbox } from "../services/mail/mail-outbox.js";
import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import type { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { POLICY_EVIDENCE_UNAVAILABLE, PolicyBlockedError, PolicyService } from "../services/policy/policy-service.js";
import { ProjectStore } from "../services/project-store.js";
import { ApprovalCoordinator, type ApprovalPublication } from "../services/runtime/approval-coordinator.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillLifecycleService } from "../services/skills/skill-lifecycle-service.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { UserSettingsStore } from "../services/user-settings-store.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { downloadAudit } from "../test-helpers/download-audit.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { auditRows, failAuditInserts, sqlText } from "./support/audit-faults.js";
import { seedApproval, seedDownloadToken, seedMembership, seedTenant, seedTenantGraph, seedUser } from "./support/fixtures.js";

const faults: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const remove of faults.splice(0)) await remove();
});

async function fault(when: string): Promise<() => Promise<void>> {
  const remove = await failAuditInserts(when);
  faults.push(remove);
  return remove;
}

async function approvalStatus(approvalId: string): Promise<string> {
  const result = await superuserPool().query<{ status: string }>(
    "SELECT status FROM approvals WHERE approval_id = $1", [approvalId]);
  return result.rows[0]!.status;
}

describe.skipIf(!adminDatabaseUrl())("audit events commit with their change", () => {
  test("a failed decision audit leaves the approval pending and the tool wait unresumed", async () => {
    const identity = { ...await seedTenantGraph(), turnId: "audit-turn" };
    const approvals = new ApprovalStore(appPool());
    const coordinator = new ApprovalCoordinator({
      approvals, auditEvents: new AuditEventStore(appPool()), logger: createSilentLogger(), ttlMs: 30_000
    });
    const published: ApprovalPublication[] = [];
    const turn = coordinator.openTurn({ identity, projectId: null, durableNative: true, signal: new AbortController().signal,
      hasLocalActor: () => true, validateLocalDecision: async () => {} });
    const wait = turn.request({ name: "execute", kind: "command_execution", args: { command: "pwd" } },
      (notice) => { published.push(notice); });
    try {
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const card = published[0]!;
      if (card.name !== "approval_required") throw new Error("Expected an approval card");
      const approvalId = card.value.approvalId;
      const removeFault = await fault(`NEW.approval_id = ${sqlText(approvalId)}`);

      await expect(coordinator.decide({ ...identity, approvalId, decision: "approve" }))
        .rejects.toThrow("injected audit insert failure");
      expect(await approvalStatus(approvalId)).toBe("pending");
      expect(await auditRows(identity.tenantId, { approvalId })).toEqual([]);
      // `decide` settles a local wait synchronously, and only after `resolve`
      // commits. A settle before the rejection would have fulfilled `wait`
      // before the two queries above returned, and a fulfilled promise wins a
      // race with a later one. So the marker wins only if the wait is pending.
      const pending = Symbol("pending");
      expect(await Promise.race([wait, Promise.resolve(pending)])).toBe(pending);

      await removeFault();
      await expect(coordinator.decide({ ...identity, approvalId, decision: "approve" })).resolves.toBe("resolved");
      await expect(wait).resolves.toBe("approve");
      expect(await approvalStatus(approvalId)).toBe("approved");
      expect(await auditRows(identity.tenantId, { approvalId })).toEqual([expect.objectContaining({
        event_type: "approval.approved", user_id: identity.userId, session_id: identity.sessionId,
        payload: { itemId: approvalId, kind: "command_execution" }
      })]);
    } finally {
      coordinator.close();
      await wait;
    }
  });

  test("a failed expiry audit leaves the approval pending", async () => {
    const t = await seedTenantGraph();
    const approvals = new ApprovalStore(appPool());
    const removeFault = await fault(`NEW.approval_id = ${sqlText(t.approvalId)}`);

    await expect(approvals.expire(t.tenantId, t.approvalId, "turn_interrupted")).rejects.toThrow("injected audit insert failure");
    expect(await approvalStatus(t.approvalId)).toBe("pending");

    await removeFault();
    expect(await approvals.expire(t.tenantId, t.approvalId, "turn_interrupted")).toMatchObject({ status: "expired" });
    expect(await auditRows(t.tenantId, { approvalId: t.approvalId })).toEqual([expect.objectContaining({
      event_type: "approval.expired", user_id: t.userId, session_id: t.sessionId, payload: { reason: "turn_interrupted" }
    })]);
  });

  test("a failure after the sweep's UPDATE rolls the whole batch back, so the next sweep expires it", async () => {
    // Two tenants: the sweep is one cross-tenant transaction on the maintenance role.
    const a = await seedTenantGraph();
    const b = await seedTenantGraph();
    const first = await seedApproval({ ...a, expired: true });
    const second = await seedApproval({ ...b, expired: true });
    const sweeper = new ApprovalStore(maintenancePool());
    const removeFault = await fault(`NEW.approval_id = ${sqlText(second)}`);

    await expect(sweeper.sweepExpired()).rejects.toThrow("injected audit insert failure");
    expect([await approvalStatus(first), await approvalStatus(second)]).toEqual(["pending", "pending"]);
    expect(await auditRows(a.tenantId, { approvalId: first })).toEqual([]);

    await removeFault();
    const swept = await sweeper.sweepExpired();
    expect(swept.map((row) => row.approvalId)).toEqual(expect.arrayContaining([first, second]));
    expect([await approvalStatus(first), await approvalStatus(second)]).toEqual(["expired", "expired"]);
    for (const [tenant, approvalId] of [[a, first], [b, second]] as const) {
      expect(await auditRows(tenant.tenantId, { approvalId })).toEqual([expect.objectContaining({
        event_type: "approval.expired", user_id: tenant.userId, session_id: tenant.sessionId,
        payload: expect.objectContaining({ reason: "stale_on_sweep" })
      })]);
    }
  });

  describe("skill activation", () => {
    async function seedRelease() {
      const tenant = await seedTenantGraph();
      const skillId = `audit-release-${randomUUID()}`;
      const skills = new SkillConfigStore(appPool());
      const revisions = new SkillRevisionStore(appPool(), skills);
      const draft = (label: string) => revisions.importSkillBundle(tenant.tenantId, {
        skillId, skillName: label, description: "Audit test", instructions: `Instructions for ${label}`,
        sourceType: "inline", sourceLabel: label, bundleName: label, bundleHash: label,
        validationStatus: "validated", validationMessages: [], metadata: {}, createdBy: tenant.userId,
        storeBundle: async () => ({ storageUri: null })
      });
      const first = await draft("First");
      await revisions.activateSkillRevision(tenant.tenantId, {
        skillId, skillRevisionId: first.revision.skillRevisionId, reviewedBy: tenant.userId, reviewNotes: null
      });
      const second = await draft("Second");
      const lifecycle = new SkillLifecycleService({
        activateSkillRevision: (tenantId: string,
          input: Omit<Parameters<SkillRevisionStore["activateSkillRevision"]>[1], "reviewedBy" | "reviewNotes"> & {
            actorUserId: string; reviewNotes?: string | null;
          }) => revisions.activateSkillRevision(tenantId, {
          ...input, reviewedBy: input.actorUserId, reviewNotes: input.reviewNotes ?? null
        })
      } as never, new AuditEventStore(appPool()));
      const notices = new DataRouteControl({ authMode: "jwt", ownerNotices: new MailOutbox({ secret: "audit-atomicity-secret-32-characters" }) });
      const request = { auth: { tenantId: tenant.tenantId, userId: tenant.userId } } as FastifyRequest;
      const activate = (alsoInTransaction = notices.ownerNotice(request, {
        setting: "skill_release", skillId, change: "revision_activated", audience: "members"
      })) => lifecycle.activateSkillRevision(tenant.tenantId, {
        skillId, skillRevisionId: second.revision.skillRevisionId, actorUserId: tenant.userId,
        reviewNotes: "Approved", audience: "members", alsoInTransaction
      });
      const state = async () => {
        const skill = await superuserPool().query<{ version: string; active_revision_id: string }>(
          "SELECT version, active_revision_id FROM admin_skills WHERE tenant_id = $1 AND skill_id = $2", [tenant.tenantId, skillId]);
        const outbox = await superuserPool().query(
          "SELECT 1 FROM email_outbox WHERE tenant_id = $1 AND kind = 'tenant_setting_changed'", [tenant.tenantId]);
        const events = (await auditRows(tenant.tenantId)).filter((row) => row.event_type.startsWith("admin.skill."));
        return {
          version: Number(skill.rows[0]!.version),
          activeRevisionId: Number(skill.rows[0]!.active_revision_id),
          notices: outbox.rowCount,
          events: events.map((row) => row.event_type)
        };
      };
      return { tenant, skillId, first, second, activate, state };
    }

    test("a failed activation audit leaves the version, the active revision and the notice uncommitted", async () => {
      const seed = await seedRelease();
      const before = await seed.state();
      expect(before).toMatchObject({ activeRevisionId: seed.first.revision.skillRevisionId, notices: 0, events: [] });
      // The second of the activation's events fails, after the first was inserted.
      const removeFault = await fault(
        `NEW.event_type = 'admin.skill.activated' AND NEW.payload->>'skillId' = ${sqlText(seed.skillId)}`);

      await expect(seed.activate()).rejects.toThrow("injected audit insert failure");
      expect(await seed.state()).toEqual(before);

      await removeFault();
      await seed.activate();
      expect(await seed.state()).toEqual({
        version: before.version + 1,
        activeRevisionId: seed.second.revision.skillRevisionId,
        notices: 1,
        events: ["admin.skill.reviewed", "admin.skill.activated"]
      });
    });

    test("a failed owner notice rolls the activation's audit events back with it", async () => {
      const seed = await seedRelease();
      const before = await seed.state();

      await expect(seed.activate(async (client) => { await client.query("SELECT 1 / 0"); }))
        .rejects.toThrow("division by zero");
      expect(await seed.state()).toEqual(before);
    });
  });

  test("a policy decision row and its audit event commit or roll back together", async () => {
    const t = await seedTenantGraph();
    const toolName = `audit_tool_${randomUUID().replaceAll("-", "")}`;
    const decisions = new PolicyDecisionStore(appPool());
    const rules = { list: async () => [{
      ruleId: "pol_audit", name: "Review", priority: 1, enabled: true, effect: "require_approval", conditions: {}, reason: "Needs review."
    }] } as unknown as PolicyRuleStore;
    const service = new PolicyService({ rules, decisions, logger: { warn: () => {} }, ruleCacheTtlMs: 0 });
    const gate = (enforcementMode: "enforce" | "monitor") => service.gateAction({
      tenantId: t.tenantId, sessionId: t.sessionId, userId: t.userId, runtimeId: null, toolName, category: null,
      severity: null, serverId: "managed", turnContext: "interactive", enforcementMode, approvalDisposition: "approve"
    });
    const decisionRows = async () => (await superuserPool().query(
      "SELECT decision_id FROM policy_decision WHERE tenant_id = $1 AND tool_name = $2", [t.tenantId, toolName])).rows;
    const removeFault = await fault(`NEW.payload->>'toolName' = ${sqlText(toolName)}`);

    // Enforced and approved: the action is refused with fixed text, and no evidence row stays without its event.
    const refused = gate("enforce");
    await expect(refused).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(refused).rejects.toMatchObject({ explanation: POLICY_EVIDENCE_UNAVAILABLE });
    // Monitor mode: the action runs, and nothing is written.
    await expect(gate("monitor")).resolves.toMatchObject({ enforced: false });
    expect(await decisionRows()).toEqual([]);

    await removeFault();
    await expect(gate("enforce")).resolves.toMatchObject({ enforced: true });
    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(await auditRows(t.tenantId, { type: "policy.decision.enforced" })).toEqual([expect.objectContaining({
      user_id: t.userId, payload: expect.objectContaining({ decisionId: rows[0]!.decision_id, approvalDisposition: "approve" })
    })]);
  });

  test("a failed download audit keeps the token unspent", async () => {
    const t = await seedTenantGraph();
    const token = await seedDownloadToken(t);
    const artifacts = new ArtifactStore(appPool(), maintenancePool());
    const removeFault = await fault(`NEW.event_type = 'artifact_downloaded' AND NEW.tenant_id = ${sqlText(t.tenantId)}`);

    await expect(artifacts.consumeDownloadToken({ token, audit: downloadAudit })).rejects.toThrow("injected audit insert failure");
    expect(await artifacts.peekDownloadToken({ token })).toMatchObject({ artifactId: t.artifactId });

    await removeFault();
    expect(await artifacts.consumeDownloadToken({ token, audit: downloadAudit })).toMatchObject({ artifactId: t.artifactId });
    expect(await artifacts.peekDownloadToken({ token })).toBeNull();
    expect(await auditRows(t.tenantId, { type: "artifact_downloaded" })).toEqual([expect.objectContaining({
      user_id: t.userId, session_id: t.sessionId, payload: { artifactId: t.artifactId }
    })]);
  });

  test("a failed settings audit saves no section", async () => {
    const t = await seedTenantGraph();
    const settings = new UserSettingsStore(appPool());
    const save = (version: string) => settings.upsertSection(
      { tenantId: t.tenantId, userId: t.userId, sectionKey: "model", config: { version } },
      (section) => ({ tenantId: t.tenantId, sessionId: null, userId: t.userId, type: "user.settings.updated",
        payload: { sectionKey: section.sectionKey, version: section.version } }));
    const removeFault = await fault(`NEW.event_type = 'user.settings.updated' AND NEW.tenant_id = ${sqlText(t.tenantId)}`);

    await expect(save("first")).rejects.toThrow("injected audit insert failure");
    expect(await settings.listSections(t.tenantId, t.userId)).toEqual([]);

    await removeFault();
    expect(await save("second")).toMatchObject({ version: 1, config: { version: "second" } });
    expect(await auditRows(t.tenantId, { type: "user.settings.updated" })).toEqual([
      expect.objectContaining({ payload: { sectionKey: "model", version: 1 } })
    ]);
  });

  // Archive, restore, delete and restore from the trash change `sessions.status`;
  // archive and delete also take the saved sandbox and stop the execution lease.
  // The routes go through the real SessionStore, so these tests show that the
  // event is in the transaction of the change, and that the route kills no
  // sandbox when the change rolls back.
  describe("session lifecycle", () => {
    /** The session routes on a normal chat whose turn saved a sandbox. */
    async function chatRoutes(options: { project?: boolean } = {}) {
      const tenantId = await seedTenant(), userId = await seedUser();
      await seedMembership(tenantId, userId);
      const sessions = new SessionStore(appPool(), maintenancePool());
      const projects = new ProjectStore(appPool());
      const sessionId = options.project
        ? (await projects.createSession(tenantId, userId, (await projects.create(tenantId, userId, "Audit")).projectId, "Shared"))!
        : (await sessions.create(tenantId, userId, "Audit lifecycle")).sessionId;
      const executions = new SessionExecutionStore(appPool(), "replica-a");
      const execution = options.project ? null : await executions.acquire({ tenantId, sessionId, userId }, 30_000);
      if (execution) await executions.bindSandboxId(execution, null, "sandbox-one", "policy-a");
      const abortSession = vi.fn(async () => {});
      const destroySandbox = vi.fn(async (_input: { tenantId: string; sessionId: string; sandboxId: string }) => "killed" as const);
      const app = Fastify();
      app.addHook("preHandler", async (request) => {
        request.auth = { tenantId, userId, role: "member", isAdmin: false };
      });
      await registerSessionRoutes(app, {
        sessions, auditEvents: new AuditEventStore(appPool()), limits: { consumeRateLimit: async () => null },
        runtimeAdapter: { id: "deep-agents", hasActiveTurn: () => false, abortSession, destroySandbox }
      } as unknown as SessionRouteStores);
      onTestFinished(() => app.close());
      const state = async () => {
        const row = (await superuserPool().query<{ status: string; sandbox_id: string | null; archived: boolean; deleted: boolean }>(
          `SELECT status, sandbox_id, archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted
           FROM sessions WHERE tenant_id = $1 AND session_id = $2`, [tenantId, sessionId])).rows[0]!;
        return { ...row, executionCurrent: execution ? await executions.isCurrent(execution) : null };
      };
      const events = async (type: string) =>
        (await auditRows(tenantId, { type })).filter((row) => row.session_id === sessionId);
      const send = (method: "POST" | "DELETE", action?: "archive" | "restore") =>
        app.inject({ method, url: action ? `/sessions/${sessionId}/${action}` : `/sessions/${sessionId}` });
      const failEvents = (type: string) =>
        fault(`NEW.event_type = ${sqlText(type)} AND NEW.session_id = ${sqlText(sessionId)}`);
      return { tenantId, userId, sessionId, state, events, send, failEvents, abortSession, destroySandbox };
    }

    test("a failed archive or restore event keeps the status, the sandbox and the lease", async () => {
      const c = await chatRoutes();
      const active = { status: "active", sandbox_id: "sandbox-one", archived: false, deleted: false, executionCurrent: true };
      expect(await c.state()).toEqual(active);

      let removeFault = await c.failEvents("session.archived");
      expect((await c.send("POST", "archive")).statusCode).toBe(500);
      expect(await c.state()).toEqual(active);
      expect(await c.events("session.archived")).toEqual([]);
      expect(c.destroySandbox).not.toHaveBeenCalled();

      await removeFault();
      const archived = await c.send("POST", "archive");
      expect(archived.statusCode).toBe(200);
      expect(archived.json().session.status).toBe("archived");
      const afterArchive = { status: "archived", sandbox_id: null, archived: true, deleted: false, executionCurrent: false };
      expect(await c.state()).toEqual(afterArchive);
      expect(c.destroySandbox).toHaveBeenCalledExactlyOnceWith({ tenantId: c.tenantId, sessionId: c.sessionId, sandboxId: "sandbox-one" });
      // A retry changes nothing and writes no second event.
      expect((await c.send("POST", "archive")).statusCode).toBe(200);
      expect(await c.events("session.archived")).toEqual([expect.objectContaining({
        user_id: c.userId, payload: { previousStatus: "active", status: "archived", purpose: "normal" }
      })]);

      removeFault = await c.failEvents("session.restored");
      expect((await c.send("POST", "restore")).statusCode).toBe(500);
      expect(await c.state()).toEqual(afterArchive);
      expect(await c.events("session.restored")).toEqual([]);

      await removeFault();
      expect((await c.send("POST", "restore")).json().session.status).toBe("active");
      expect((await c.send("POST", "restore")).statusCode).toBe(200);
      expect(await c.state()).toMatchObject({ status: "active", archived: false });
      expect(await c.events("session.restored")).toEqual([expect.objectContaining({
        user_id: c.userId, payload: { previousStatus: "archived", status: "active", purpose: "normal" }
      })]);
      expect(c.destroySandbox).toHaveBeenCalledOnce();
    });

    test("a failed delete event keeps the session out of the trash and kills nothing", async () => {
      const c = await chatRoutes();
      const before = await c.state();
      const removeFault = await c.failEvents("session.deleted");

      expect((await c.send("DELETE")).statusCode).toBe(500);
      expect(await c.state()).toEqual(before);
      expect(await c.events("session.deleted")).toEqual([]);
      expect(c.abortSession).not.toHaveBeenCalled();
      expect(c.destroySandbox).not.toHaveBeenCalled();

      await removeFault();
      expect((await c.send("DELETE")).statusCode).toBe(204);
      expect(await c.state()).toEqual({ status: "deleted", sandbox_id: null, archived: false, deleted: true, executionCurrent: false });
      expect(c.abortSession).toHaveBeenCalledOnce();
      expect(c.destroySandbox).toHaveBeenCalledExactlyOnceWith({ tenantId: c.tenantId, sessionId: c.sessionId, sandboxId: "sandbox-one" });
      // The session is in the trash: a second delete finds nothing to change.
      expect((await c.send("DELETE")).statusCode).toBe(404);
      expect(await c.events("session.deleted")).toEqual([expect.objectContaining({
        user_id: c.userId, payload: { previousStatus: "active", fromTrash: true }
      })]);
    });

    test("a failed event of a restore from the trash keeps the session in the trash", async () => {
      const c = await chatRoutes();
      expect((await c.send("DELETE")).statusCode).toBe(204);
      const trashed = await c.state();
      const removeFault = await c.failEvents("session.restored");

      expect((await c.send("POST", "restore")).statusCode).toBe(500);
      expect(await c.state()).toEqual(trashed);
      expect(await c.events("session.restored")).toEqual([]);

      await removeFault();
      expect((await c.send("POST", "restore")).json().session.status).toBe("active");
      // The retry finds an active session: no change and no second event.
      expect((await c.send("POST", "restore")).statusCode).toBe(200);
      expect(await c.state()).toMatchObject({ status: "active", deleted: false });
      expect(await c.events("session.restored")).toEqual([expect.objectContaining({
        user_id: c.userId, payload: { previousStatus: "deleted", status: "active", fromTrash: true }
      })]);
    });

    // A project session has no early return in the route: each retry reaches the
    // store, which writes an event only when the status changes.
    test("a project session's archive and restore retries write one event each", async () => {
      const c = await chatRoutes({ project: true });
      const removeFault = await c.failEvents("session.archived");
      expect((await c.send("POST", "archive")).statusCode).toBe(500);
      expect(await c.state()).toMatchObject({ status: "active", archived: false });

      await removeFault();
      for (const action of ["archive", "archive", "restore", "restore"] as const) {
        expect((await c.send("POST", action)).statusCode).toBe(200);
      }
      expect(await c.state()).toMatchObject({ status: "active", archived: false });
      expect((await c.events("session.archived")).map((row) => row.payload)).toEqual([
        { previousStatus: "active", status: "archived", purpose: "normal" }
      ]);
      expect((await c.events("session.restored")).map((row) => row.payload)).toEqual([
        { previousStatus: "archived", status: "active", purpose: "normal" }
      ]);
    });
  });
});
