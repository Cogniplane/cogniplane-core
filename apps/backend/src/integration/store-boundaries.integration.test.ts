import { randomUUID } from "node:crypto";
import { describe, expect, onTestFinished, test } from "vitest";
import { classifyMimeClass, MIME_CLASSES } from "@cogniplane/shared-types";
import { RuntimeSessionStore } from "../services/runtime/runtime-session-store.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedArtifact, seedRuntimeSession, seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("store SQL boundaries", () => {
  test("stale runtime updates preserve the replacement and never revive terminal rows", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const replacement = await seedRuntimeSession(owner.tenantId, owner.userId, owner.sessionId);
    await superuserPool().query("UPDATE runtime_sessions SET status = 'active' WHERE session_id = $1", [owner.sessionId]);
    const store = new RuntimeSessionStore(appPool());
    expect(await store.setStatus(foreign.tenantId, owner.sessionId, owner.userId, "inactive", owner.runtimeId)).toBeNull();
    expect(await store.setStatus(owner.tenantId, owner.sessionId, foreign.userId, "inactive", owner.runtimeId)).toBeNull();
    expect(await store.setStatus(owner.tenantId, foreign.sessionId, owner.userId, "inactive", owner.runtimeId)).toBeNull();
    expect(await store.setStatus(owner.tenantId, owner.sessionId, owner.userId, "terminated", owner.runtimeId))
      .toMatchObject({ runtimeId: owner.runtimeId, status: "terminated" });
    const statuses = async () => (await superuserPool().query(
      "SELECT runtime_id, status FROM runtime_sessions WHERE session_id = $1 ORDER BY runtime_id", [owner.sessionId]
    )).rows;
    expect(await statuses()).toEqual([
      { runtime_id: owner.runtimeId, status: "terminated" }, { runtime_id: replacement, status: "active" }
    ].sort((a, b) => a.runtime_id.localeCompare(b.runtime_id)));
    expect(await store.setStatus(owner.tenantId, owner.sessionId, owner.userId, "active", owner.runtimeId)).toBeNull();
    expect(await store.setStatus(owner.tenantId, owner.sessionId, owner.userId, "inactive"))
      .toMatchObject({ runtimeId: replacement, status: "inactive" });
    expect(await store.setStatus(owner.tenantId, owner.sessionId, owner.userId, "error", replacement))
      .toMatchObject({ status: "error" });
    expect(await store.setStatus(owner.tenantId, owner.sessionId, owner.userId, "active")).toBeNull();
    expect(await statuses()).toEqual([
      { runtime_id: owner.runtimeId, status: "terminated" }, { runtime_id: replacement, status: "error" }
    ].sort((a, b) => a.runtime_id.localeCompare(b.runtime_id)));
  });

  test("policy rules use tenant-local priorities and a deterministic tie break", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    expect(await store.nextAppendPriority(owner.tenantId)).toBe(0);
    const first = await store.create(owner.tenantId, { name: "first", effect: "allow" }, owner.userId);
    expect(first).toMatchObject({ priority: 0, createdBy: owner.userId, enabled: true });
    const late = await store.create(owner.tenantId, { name: "late", effect: "block", priority: 40 }, owner.userId);
    const tieB = await store.create(owner.tenantId, { name: "tie B", effect: "allow", priority: 5 }, owner.userId);
    const tieA = await store.create(owner.tenantId, { name: "tie A", effect: "allow", priority: 5 }, owner.userId);
    const other = await store.create(foreign.tenantId, { name: "foreign", effect: "allow", priority: 900 }, foreign.userId);
    expect(await store.nextAppendPriority(owner.tenantId)).toBe(50);
    const appended = await store.create(owner.tenantId, { name: "appended", effect: "allow" }, owner.userId);
    expect(appended.priority).toBe(50);
    const expected = [first.ruleId, ...[tieA.ruleId, tieB.ruleId].sort(), late.ruleId, appended.ruleId];
    expect((await store.list(owner.tenantId)).map(rule => rule.ruleId)).toEqual(expected);
    expect((await store.listForLint(owner.tenantId)).map(rule => rule.ruleId)).toEqual(expected);
    expect((await store.list(foreign.tenantId)).map(rule => rule.ruleId)).toEqual([other.ruleId]);
  });

  test("artifact MIME filters classify the stored corpus in PostgreSQL", async () => {
    const owner = await seedTenantGraph();
    const corpus = ["image/png", "image/svg+xml", "application/pdf", "application/json", "text/javascript",
      "text/x-python", "text/x-typescript", "application/x-sh", "text/html", "text/plain", "text/markdown",
      "text/csv", "application/octet-stream", "application/zip", "audio/mpeg"];
    const rows: Array<{ id: string; mime: string }> = [];
    for (const [index, mime] of corpus.entries()) {
      const id = index === 0 ? owner.artifactId : await seedArtifact(owner.tenantId, owner.userId, owner.sessionId);
      await superuserPool().query("UPDATE artifacts SET mime_type = $2 WHERE artifact_id = $1", [id, mime]);
      rows.push({ id, mime });
    }
    const store = new ArtifactStore(appPool());
    for (const mimeClass of MIME_CLASSES) {
      const page = await store.listForUser(owner.tenantId, owner.userId, { mimeClass: [mimeClass], limit: 100 });
      expect(page.items.map(item => item.artifactId).sort(), mimeClass)
        .toEqual(rows.filter(row => classifyMimeClass(row.mime) === mimeClass).map(row => row.id).sort());
      expect(page.nextCursor).toBeNull();
    }
  });

  test("a tenant MCP row wins over the inherited row with the same ID", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const serverId = `collision-${randomUUID()}`;
    onTestFinished(async () => {
      await superuserPool().query("DELETE FROM admin_mcp_servers WHERE server_id = $1", [serverId]);
    });
    for (const [tenantId, name] of [["system", "Inherited"], [owner.tenantId, "Tenant override"], [foreign.tenantId, "Foreign"]]) {
      await superuserPool().query(
        `INSERT INTO admin_mcp_servers (tenant_id, server_id, server_name, transport_kind, mode, route_path,
          version, config_hash, enabled, is_published, created_by)
         VALUES ($1, $2, $3, 'http', 'managed', $4, 1, 'test', TRUE, TRUE, 'system')`,
        [tenantId, serverId, name, `/mcp/${serverId}`]
      );
    }
    const store = new McpServerStore(appPool(), "integration-test-encryption-secret-value");
    expect((await store.listMcpServers(owner.tenantId)).filter(row => row.serverId === serverId))
      .toMatchObject([{ serverId, serverName: "Tenant override" }]);
    expect((await store.listMcpServers(foreign.tenantId)).filter(row => row.serverId === serverId))
      .toMatchObject([{ serverId, serverName: "Foreign" }]);
  });
});
