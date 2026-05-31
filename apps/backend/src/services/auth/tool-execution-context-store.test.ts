import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { ToolContextUnavailableError, ToolExecutionContextStore } from "./tool-execution-context-store.js";

type StoredContextRow = {
  tool_context_id: string;
  tenant_id: string;
  session_id: string;
  user_id: string;
  runtime_id: string;
  runtime_policy_id: string;
  message_id: string | null;
  credential_envelope: Record<string, unknown>;
  metadata: Record<string, unknown>;
  expires_at: string;
  created_at: string;
};

class FakeToolContextDatabase {
  private readonly rows = new Map<string, StoredContextRow>();
  private nowMs = Date.parse("2026-03-15T00:00:00.000Z");

  advanceBy(ms: number): void {
    this.nowMs += ms;
  }

  async query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config('app.current_tenant_id'")
    ) {
      return {
        rows: [],
        rowCount: 0
      };
    }

    if (text.includes("INSERT INTO tool_execution_contexts")) {
      const row: StoredContextRow = {
        tool_context_id: String(values[0]),
        tenant_id: String(values[1]),
        session_id: String(values[2]),
        user_id: String(values[3]),
        runtime_id: String(values[4]),
        runtime_policy_id: String(values[5]),
        message_id: values[6] == null ? null : String(values[6]),
        credential_envelope: JSON.parse(String(values[7])) as Record<string, unknown>,
        metadata: JSON.parse(String(values[8])) as Record<string, unknown>,
        expires_at: new Date(this.nowMs + Number(values[9])).toISOString(),
        created_at: new Date(this.nowMs).toISOString()
      };
      this.rows.set(row.tool_context_id, row);
      return {
        rows: [row],
        rowCount: 1
      };
    }

    if (text.includes("FROM tool_execution_contexts")) {
      const row = this.rows.get(String(values[1]));
      const isActive = row && row.tenant_id === String(values[0]) && Date.parse(row.expires_at) > this.nowMs;
      return {
        rows: isActive ? [row] : [],
        rowCount: isActive ? 1 : 0
      };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  }

  async connect(): Promise<{
    query: (text: string, values?: unknown[]) => Promise<{ rows: StoredContextRow[]; rowCount: number }>;
    release: () => void;
  }> {
    return {
      query: (text: string, values: unknown[] = []) => this.query(text, values),
      release: () => {}
    };
  }
}

test("ToolExecutionContextStore resolves a valid owned context before expiry", async () => {
  const db = new FakeToolContextDatabase();
  const store = new ToolExecutionContextStore(db as unknown as Pool);

  const created = await store.create({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimePolicyId: "phase4-tools",
    messageId: "message-1",
    credentialEnvelope: {
      accessToken: "secret"
    },
    metadata: {
      source: "test"
    },
    ttlMs: 1_000
  });

  const resolved = await store.requireOwned("test-tenant", created.toolContextId, "user-1");

  expect(resolved.toolContextId).toBe(created.toolContextId);
  expect(resolved.sessionId).toBe("session-1");
  expect(resolved.messageId).toBe("message-1");
  expect(resolved.metadata).toEqual({
        source: "test"
      });
  expect(await store.getOwned("test-tenant", created.toolContextId, "someone-else")).toBe(null);
});

test("ToolExecutionContextStore treats expired contexts as missing", async () => {
  const db = new FakeToolContextDatabase();
  const store = new ToolExecutionContextStore(db as unknown as Pool);

  const created = await store.create({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimePolicyId: "phase4-tools",
    messageId: null,
    ttlMs: 50
  });

  db.advanceBy(51);

  expect(await store.get("test-tenant", created.toolContextId)).toBe(null);
  // Assert the typed contract (code + error class), not the prose message, so
  // wording changes don't break the test and callers can branch on `.code`.
  const error = await store
    .require("test-tenant", created.toolContextId)
    .then(() => null)
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(ToolContextUnavailableError);
  expect((error as ToolContextUnavailableError).code).toBe("TOOL_CONTEXT_UNAVAILABLE");
  expect((error as ToolContextUnavailableError).toolContextId).toBe(created.toolContextId);
});
