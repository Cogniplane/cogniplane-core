import { describe, expect, test } from "vitest";

import { ApprovalStore } from "../services/auth/approval-store.js";
import { adminDatabaseUrl } from "./support/database.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

describe.skipIf(!adminDatabaseUrl())("approval tool call ID migration", () => {
  test("keeps existing approvals unlinked and round-trips new links", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) < 85);
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ('t', 'Test', 'approval-migration')");
      await db.query("INSERT INTO users (user_id, email) VALUES ('u', 'approval-migration@example.test')");
      await db.query("INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ('s', 't', 'u', 'Test')");
      await db.query(`INSERT INTO runtime_sessions
        (session_id, tenant_id, user_id, runtime_id, workspace_path, runtime_version)
        VALUES ('s', 't', 'u', 'r', '/tmp/test', 'test')`);
      await db.query(`INSERT INTO approvals
        (approval_id, tenant_id, session_id, user_id, runtime_id, turn_id, item_id,
         request_method, request_id, kind, title, summary, expires_at)
        VALUES ('old', 't', 's', 'u', 'r', 'turn', 'old', 'tool', 'old', 'command_execution',
          'Existing approval', 'Run a command', NOW() + INTERVAL '1 hour')`);
      const before = (await db.query("SELECT * FROM approvals WHERE approval_id='old'")).rows[0];

      await migrate((file) => file.startsWith("085_"));
      const after = (await db.query("SELECT * FROM approvals WHERE approval_id='old'")).rows[0];
      expect(after).toEqual({ ...before, tool_call_id: null });
      const store = new ApprovalStore(db);
      const old = await store.get("t", "old", "u");
      expect(old).not.toHaveProperty("toolCallId");
      expect(old?.status).toBe("pending");

      const linked = await store.create({
        approvalId: "new", tenantId: "t", sessionId: "s", userId: "u", runtimeId: "r",
        turnId: "turn", itemId: "new", requestMethod: "tool", requestId: "new",
        kind: "command_execution", title: "New approval", summary: "Run a command",
        status: "pending", decision: null, toolCallId: "server-proposal-42", requestPayload: {},
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      });
      expect(linked.toolCallId).toBe("server-proposal-42");
      expect(await store.get("t", "new", "u")).toMatchObject({ toolCallId: "server-proposal-42" });
      expect(await store.listPending("t", "s", "u")).toHaveLength(2);
    });
  }, 120_000);
});
