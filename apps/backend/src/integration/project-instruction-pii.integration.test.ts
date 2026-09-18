import { describe, expect, test } from "vitest";
import { PiiRecentRowSchema } from "@cogniplane/shared-types";
import { handlePiiDecision } from "../routes/messages-pii-handler.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { PiiAnalyticsStore } from "../services/pii/pii-analytics-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("project instruction PII evidence", () => {
  test("persists project/revision attribution through scan, audit, and analytics reads", async () => {
    const tenantId = await seedTenant(), otherTenant = await seedTenant(), userId = await seedUser();
    const sessionId = await seedSession(tenantId, userId);
    const scans = new PiiScanRunStore(appPool());
    const analytics = new PiiAnalyticsStore(appPool());
    const stores = { piiScanRuns: scans, auditEvents: new AuditEventStore(appPool()) };
    const base = { tenantId, sessionId, userId, rawText: "Sensitive text" };
    const common = { findings: [], providerType: "rule_based", providerModel: null };
    for (const decision of [
      { ...common, action: "report" as const },
      { ...common, action: "block" as const, blockReason: "policy" },
      { ...common, action: "transform" as const, transformedText: "[PERSON]" }
    ]) {
      await handlePiiDecision(decision, { ...base, projectInstructions: { projectId: "project-evidence", revision: 7 } }, stores);
    }
    await handlePiiDecision({ ...common, action: "report" }, base, stores);
    await handlePiiDecision({ action: "allow", reason: "no_findings" },
      { ...base, projectInstructions: { projectId: "project-evidence", revision: 7 } }, stores);
    const from = new Date(Date.now() - 60_000), to = new Date(Date.now() + 60_000);
    const recent = await analytics.getRecentActivity(tenantId, from, to, ["report", "block", "transform"], 20);
    expect(recent).toHaveLength(4);
    const projectRows = recent.filter((row) => row.subjectType === "project_instructions");
    expect(projectRows).toHaveLength(3);
    for (const row of projectRows) {
      expect(PiiRecentRowSchema.parse(row)).toMatchObject({ subjectId: "project-evidence", instructionsRevision: 7, sessionId });
      expect(await scans.getById(tenantId, row.scanRunId)).toMatchObject({ subjectType: "project_instructions",
        subjectId: "project-evidence", instructionsRevision: 7, sourceSessionId: sessionId });
      expect(await scans.update(tenantId, row.scanRunId, { summaryText: "Reviewed" })).toMatchObject({ instructionsRevision: 7 });
      expect(await scans.getById(otherTenant, row.scanRunId)).toBeNull();
    }
    expect(await analytics.getBySubjectType(tenantId, from, to)).toEqual(expect.arrayContaining([
      { subjectType: "project_instructions", count: 3 }, { subjectType: "message", count: 1 }
    ]));
    expect(await analytics.getRecentActivity(otherTenant, from, to, ["report"], 20)).toEqual([]);
    const audit = await withTenantScope(appPool(), tenantId, (db) => db.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND session_id = $2", [tenantId, sessionId]));
    expect(audit.rows.filter((r) => r.payload.subjectType === "project_instructions")).toHaveLength(3);
    for (const row of audit.rows.filter((r) => r.payload.subjectType === "project_instructions")) {
      expect(row.payload).toMatchObject({ projectId: "project-evidence", instructionsRevision: 7 });
      expect(JSON.stringify(row.payload)).not.toContain("Sensitive text");
    }
    await expect(scans.create({ tenantId, subjectType: "project_instructions", subjectId: "project-evidence", mode: "detect" }))
      .rejects.toThrow(/pii_scan_runs_instructions_revision_check/);
  });
});
