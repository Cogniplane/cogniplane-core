import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

// A change of governed state writes its audit event in the change's
// transaction (`AuditEventStore.createInTransaction`, or an audit builder that
// the store runs on its client). Then a failed event rolls the change back, and
// a committed change always has its event (docs/architecture/data.md, "Audit
// and observability").
//
// This test reads the backend source and the private overlays and finds:
//
// - each SQL string that inserts into audit_events: only the canonical writer
//   may, so redaction, the request columns and alsoInTransaction apply;
// - each standalone write: `auditEvents.create(...)`,
//   `auditEvents.createSystemEvent(...)` and `createAdminAuditEvent(...)`.
//   Each one must be listed in STANDALONE_SITES with the reason why no
//   database change can share its transaction, and with the number of writes
//   in its function. A new standalone write in a listed function changes the
//   count, so it fails the test until someone gives it a reason too.
//
// Limits of the scan:
//
// - It finds a standalone write by name (`auditEvents`, the name that the
//   stores, the route dependencies and the overlays use). An AuditEventStore
//   held under another name, or a write through a helper that has another
//   name, is not found.
// - It identifies a site by file and enclosing function, and counts the call
//   expressions in the source. It does not see how often a call runs: a loop or
//   a second path to the same call counts once.
// - A site that drops one write and adds another in the same function keeps
//   its count. A review of the diff must catch that.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRIVATE_ROOT = path.join(REPO_ROOT, "private");

/** The backend source and the source of each private overlay. The public mirror has no private/ directory. */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "apps/backend/src"),
  ...(existsSync(PRIVATE_ROOT)
    ? readdirSync(PRIVATE_ROOT).map((name) => path.join(PRIVATE_ROOT, name, "src")).filter((dir) => existsSync(dir))
    : [])
];

/** Directories of test code: fakes and integration support write audit rows on purpose. */
const TEST_DIRECTORIES = new Set(["node_modules", "test-helpers", "integration"]);

const CANONICAL_WRITER = "apps/backend/src/services/audit-event-store.ts";

const AUDIT_INSERT = /\bINSERT\s+INTO\s+(?:public\.)?"?audit_events"?/i;

type StandaloneSite = { writes: number; reason: string };

/**
 * The standalone audit writes, by file and by enclosing function: the number
 * of write calls in the function, and the reason that no database change can
 * share the events' transaction. Each reason is one of:
 *
 * - telemetry: the event records no change of governed state (a refusal, a
 *   detection, a sign-in observation, a reuse of an approval);
 * - outside PostgreSQL: the action is in Redis, the runtime or a remote
 *   service, so there is no transaction to join;
 * - summary: the event reports an operation of many transactions.
 */
const STANDALONE_SITES: Record<string, Record<string, StandaloneSite>> = {
  "apps/backend/src/routes/admin/admin-integrations-routes.ts": {
    invalidateAndAudit: { writes: 1, reason: "outside PostgreSQL: records a runtime teardown after the committed integration change" }
  },
  "apps/backend/src/routes/admin/admin-route-helpers.ts": {
    createAdminAuditEvent: { writes: 1, reason: "the standalone helper itself; its callers are listed" }
  },
  "apps/backend/src/routes/admin/admin-runtime-routes.ts": {
    "POST /admin/runtime-sessions/rollout": { writes: 1, reason: "outside PostgreSQL: records a runtime teardown" }
  },
  "apps/backend/src/routes/auth-local.ts": {
    "POST /auth/step-up": { writes: 1, reason: "outside PostgreSQL: the step-up token is in Redis" },
    "POST /auth/step-up/passkey": { writes: 1, reason: "outside PostgreSQL: the step-up token is in Redis" }
  },
  "apps/backend/src/routes/auth-session.ts": {
    auditReuse: { writes: 1, reason: "outside PostgreSQL: the refresh-token family is revoked in Redis; a Redis marker keeps a failed event" },
    auditKeptReuse: { writes: 1, reason: "outside PostgreSQL: the late event of a reuse that a Redis marker kept" }
  },
  "apps/backend/src/routes/auth.ts": {
    "POST /auth/callback": {
      writes: 2,
      reason: "telemetry: role_changed and role_sync_divergence observe the WorkOS role at sign-in; provisioning keeps the stored app role"
    }
  },
  "apps/backend/src/routes/sessions.ts": {
    "POST /sessions/:sessionId/interrupt": {
      writes: 2,
      reason: "telemetry: a stop request; the execution fence writes its own event in its transaction"
    }
  },
  "apps/backend/src/services/mcp/gateway-admission.ts": {
    recordGatewayRejection: { writes: 1, reason: "telemetry: a refused gateway request changes nothing" }
  },
  "apps/backend/src/services/pii/chat-prompt-pii.ts": {
    emitPiiAudit: { writes: 1, reason: "telemetry: a detection outcome; the verdict is on the message or the refusal" }
  },
  "apps/backend/src/services/pii/pii-artifact-scan-enqueuer.ts": {
    "PiiArtifactScanEnqueuer.emitAudit": { writes: 1, reason: "telemetry: a detection outcome; the verdict is in the artifact's PII detail" }
  },
  "apps/backend/src/services/pii/pii-scan-job-handler.ts": {
    "PiiScanJobHandler.emitAudit": {
      writes: 2,
      reason: "telemetry: a detection outcome, written once per scan run, as the source user or as the system; the verdict is in the PII detail"
    }
  },
  "apps/backend/src/services/runtime/approval-coordinator.ts": {
    "ApprovalCoordinator.request": { writes: 1, reason: "telemetry: a remembered approval is reused; no row changes, and the approval has its own event" }
  },
  "apps/backend/src/services/skills/skill-lifecycle-service.ts": {
    "SkillLifecycleService.cleanupInactiveSkillRevisions": {
      writes: 1,
      reason: "summary: the cleanup is many revision deletes and bundle storage deletes, with no single transaction"
    }
  }
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return TEST_DIRECTORIES.has(entry.name) ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

function routeText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return null;
}

/**
 * The name of the function that holds `node`: `Class.method`, a function or
 * variable name, or `VERB /path` for a route handler. Anonymous callbacks count
 * as part of the function or route around them.
 */
function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      const owner = current.parent;
      const className = ts.isClassDeclaration(owner) && owner.name ? owner.name.text : "?";
      return `${className}.${current.name.text}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
        (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
      return current.name.text;
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) && current.expression.expression.text === "app") {
      const route = current.arguments[0] ? routeText(current.arguments[0]) : null;
      if (route) return `${current.expression.name.text.toUpperCase()} ${route}`;
    }
  }
  return "(top level)";
}

/** True for `auditEvents.create(...)`, `this.deps.auditEvents?.createSystemEvent(...)` and the like. */
function isStandaloneWrite(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "createAdminAuditEvent";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "create" && callee.name.text !== "createSystemEvent") return false;
  const target = callee.expression;
  const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : null;
  return name === "auditEvents";
}

function scan(): { inserts: string[]; sites: Record<string, Record<string, number>> } {
  const inserts: string[] = [];
  const sites: Record<string, Record<string, number>> = {};
  for (const file of SCAN_ROOTS.flatMap(sourceFiles)) {
    const relative = path.relative(REPO_ROOT, file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
          AUDIT_INSERT.test(node.getText(source))) {
        inserts.push(`${relative} ${enclosingName(node)}`);
      }
      if (ts.isCallExpression(node) && isStandaloneWrite(node)) {
        const functionSites = (sites[relative] ??= {});
        const name = enclosingName(node);
        functionSites[name] = (functionSites[name] ?? 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { inserts, sites };
}

describe("audit event writers", () => {
  const { inserts, sites } = scan();

  test("the scan reads the private overlays when they are present", () => {
    if (!existsSync(PRIVATE_ROOT)) return;
    expect(SCAN_ROOTS.some((root) => root.startsWith(PRIVATE_ROOT))).toBe(true);
  });

  test("the SQL check finds an audit insert in each form", () => {
    for (const sql of [
      "INSERT INTO audit_events (tenant_id) VALUES ($1)",
      "insert into audit_events(tenant_id,user_id) values ($1,$2)",
      "INSERT INTO public.audit_events (tenant_id) VALUES ($1)",
      'INSERT INTO "audit_events" (tenant_id) VALUES ($1)'
    ]) expect(AUDIT_INSERT.test(sql), sql).toBe(true);
    for (const sql of ["SELECT 1 FROM audit_events WHERE tenant_id = $1", "INSERT INTO audit_event_exports (id) VALUES ($1)"]) {
      expect(AUDIT_INSERT.test(sql), sql).toBe(false);
    }
  });

  test("only AuditEventStore inserts into audit_events", () => {
    expect(inserts).toEqual([`${CANONICAL_WRITER} AuditEventStore.createInTransaction`]);
  });

  test("every standalone audit write is listed with its reason and count, and every listed site still writes", () => {
    const listed = Object.fromEntries(Object.entries(STANDALONE_SITES).map(([file, entries]) =>
      [file, Object.fromEntries(Object.entries(entries).map(([name, site]) => [name, site.writes]))]));
    // A private overlay that is absent (the public mirror) lists nothing here.
    expect(sites).toEqual(listed);
  });

  test("each listed site has a reason", () => {
    for (const [file, entries] of Object.entries(STANDALONE_SITES)) {
      for (const [name, site] of Object.entries(entries)) {
        expect(site.reason.trim(), `${file} ${name}`).not.toBe("");
        expect(site.writes, `${file} ${name}`).toBeGreaterThan(0);
      }
    }
  });
});
