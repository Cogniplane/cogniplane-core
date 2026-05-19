import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";

import { RuntimeSessionStore } from "./runtime-session-store.js";

type QueryCall = {
  sql: string;
  params: unknown[];
};

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

class CaptureRuntimeSessionDatabase {
  readonly calls: QueryCall[] = [];

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }> {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {}
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ sql, params });

    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("UPDATE runtime_sessions") && sql.includes("WHERE runtime_id =")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("UPDATE runtime_sessions") && sql.includes("SET status = 'terminated'")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO runtime_sessions")) {
      return {
        rows: [buildRuntimeSessionRow(params)],
        rowCount: 1
      };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  }
}

function buildRuntimeSessionRow(params: unknown[]): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: String(params[0]),
    session_id: String(params[1]),
    user_id: String(params[2]),
    runtime_id: String(params[3]),
    workspace_path: String(params[4]),
    codex_version: String(params[5]),
    codex_schema_version: String(params[6]),
    manifest_path: String(params[7]),
    manifest_metadata: JSON.parse(String(params[8])) as RuntimeManifest,
    health_status: String(params[9]),
    last_active_at: params[10] == null ? null : String(params[10]),
    started_at: params[11] == null ? null : String(params[11]),
    terminated_at: params[12] == null ? null : String(params[12]),
    lifecycle_metadata: JSON.parse(String(params[13])) as Record<string, unknown>,
    status: String(params[14]),
    runtime_provider: String(params[15]),
    created_at: "2026-04-08T12:00:00.000Z",
    updated_at: "2026-04-08T12:00:00.000Z"
  };
}

function extractPlaceholderNumbers(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

test("RuntimeSessionStore.setStatus returns null when no row matched", async () => {
  const db = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
          if (sql.includes("UPDATE runtime_sessions")) return { rows: [], rowCount: 0 };
          throw new Error(`Unexpected ${sql}`);
        },
        async release() {}
      };
    }
  } as unknown as Pool;
  const store = new RuntimeSessionStore(db);
  const result = await store.setStatus("t", "s", "u", "terminated");
  expect(result).toBe(null);
});

test("RuntimeSessionStore.setStatus returns the updated row when matched", async () => {
  const db = {
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
          if (sql.includes("UPDATE runtime_sessions")) {
            return {
              rows: [
                {
                  id: 1,
                  tenant_id: params[3],
                  session_id: params[0],
                  user_id: params[1],
                  runtime_id: "rt",
                  workspace_path: "/ws",
                  codex_version: "1",
                  codex_schema_version: "v2",
                  manifest_path: "/m",
                  manifest_metadata: {},
                  health_status: "terminated",
                  last_active_at: null,
                  started_at: null,
                  terminated_at: null,
                  lifecycle_metadata: {},
                  status: params[2],
                  runtime_provider: "codex",
                  created_at: "2026-04-08T12:00:00.000Z",
                  updated_at: "2026-04-08T12:00:00.000Z"
                }
              ],
              rowCount: 1
            };
          }
          throw new Error(`Unexpected ${sql}`);
        },
        async release() {}
      };
    }
  } as unknown as Pool;
  const store = new RuntimeSessionStore(db);
  const result = await store.setStatus("t", "s", "u", "terminated");
  expect(result).toBeTruthy();
  expect(result!.status).toBe("terminated");
});

test("RuntimeSessionStore.listRecent returns mapped rows", async () => {
  const db = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
          if (sql.includes("FROM runtime_sessions")) {
            return {
              rows: [
                {
                  id: 1,
                  tenant_id: "t",
                  session_id: "s",
                  user_id: "u",
                  runtime_id: "rt",
                  workspace_path: "/ws",
                  codex_version: "1",
                  codex_schema_version: "v2",
                  manifest_path: "/m",
                  manifest_metadata: {},
                  health_status: "healthy",
                  last_active_at: null,
                  started_at: null,
                  terminated_at: null,
                  lifecycle_metadata: {},
                  status: "active",
                  runtime_provider: "codex",
                  created_at: "2026-04-08T12:00:00.000Z",
                  updated_at: "2026-04-08T12:00:00.000Z"
                }
              ],
              rowCount: 1
            };
          }
          throw new Error(`Unexpected ${sql}`);
        },
        async release() {}
      };
    }
  } as unknown as Pool;
  const store = new RuntimeSessionStore(db);
  const result = await store.listRecent("t");
  expect(result.length).toBe(1);
  expect(result[0].sessionId).toBe("s");
});

test("RuntimeSessionStore.upsert uses a contiguous parameter list for runtime-id updates", async () => {
  const db = new CaptureRuntimeSessionDatabase();
  const store = new RuntimeSessionStore(db as unknown as Pool);

  const record = await store.upsert({
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimeProvider: "codex",
    workspacePath: "/tmp/runtime-1",
    runtimeVersion: "1.2.3",
    runtimeSchemaVersion: "v2",
    manifestPath: "/tmp/runtime-1/.framework/runtime-manifest.json",
    manifestMetadata: {
      generatedAt: "2026-04-08T12:00:00.000Z",
      tenantId: "tenant-1",
      runtimePolicy: {
        id: "cap-1",
        enabledToolIds: [],
        enabledMcpServerIds: [],
        approvalPolicy: "never",
        autoApproveReadOnlyTools: false
      },
      mcpServers: [],
      skills: []
    },
    healthStatus: "healthy",
    lastActiveAt: "2026-04-08T12:00:00.000Z",
    startedAt: "2026-04-08T12:00:00.000Z",
    terminatedAt: null,
    lifecycleMetadata: {
      reason: "test"
    },
    status: "active"
  });

  const updateCall = db.calls.find(
    (call) => call.sql.includes("UPDATE runtime_sessions") && call.sql.includes("WHERE runtime_id =")
  );

  expect(updateCall).toBeTruthy();
  expect([...new Set(extractPlaceholderNumbers(updateCall.sql))].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expect(updateCall.params.length).toBe(15);
  expect(updateCall.params[0]).toBe("tenant-1");
  expect(updateCall.params[1]).toBe("user-1");
  expect(updateCall.params[2]).toBe("runtime-1");
  expect(record.sessionId).toBe("session-1");
  expect(record.runtimeId).toBe("runtime-1");
});
