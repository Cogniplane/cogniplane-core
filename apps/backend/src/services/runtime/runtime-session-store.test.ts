import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";

import {
  RuntimeSessionStore,
  type RuntimeSessionUpsertInput
} from "./runtime-session-store.js";

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
    runtime_version: String(params[5]),
    runtime_schema_version: String(params[6]),
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
                  runtime_version: "1",
                  runtime_schema_version: "v2",
                  manifest_path: "/m",
                  manifest_metadata: {},
                  health_status: "terminated",
                  last_active_at: null,
                  started_at: null,
                  terminated_at: null,
                  lifecycle_metadata: {},
                  status: params[2],
                  runtime_provider: "deep-agents",
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

/**
 * A fake `runtime_sessions` table that evaluates `setStatus`'s UPDATE predicate
 * against real rows instead of matching SQL text. Critically, it derives the
 * runtime-id guard from the *actual SQL emitted by production* — so the
 * anti-clobber contract (`$5 IS NULL OR runtime_id = $5`) is behaviorally
 * exercised: flipping the `OR` to `AND`, or dropping the guard entirely, changes
 * which rows this fake updates and the assertions below fail.
 */
function makeSetStatusTable(rows: Array<{ runtime_id: string; status: string }>) {
  const table = rows.map((r, i) => ({
    id: i + 1,
    tenant_id: "t",
    session_id: "s",
    user_id: "u",
    runtime_id: r.runtime_id,
    runtime_provider: "deep-agents",
    workspace_path: "/ws",
    runtime_version: "1",
    runtime_schema_version: "v2",
    manifest_path: "/m",
    manifest_metadata: {},
    health_status: "ok",
    last_active_at: null,
    started_at: null,
    terminated_at: null,
    lifecycle_metadata: {},
    status: r.status,
    created_at: "2026-04-08T12:00:00.000Z",
    updated_at: "2026-04-08T12:00:00.000Z"
  }));

  const db = {
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
          if (sql.includes("UPDATE runtime_sessions") && sql.includes("SET status = $3")) {
            const [sessionId, userId, status, tenantId, runtimeId] = params as [
              string,
              string,
              string,
              string,
              string | null
            ];
            // Re-derive the guard from the production SQL. If production ever
            // drops the `($5 IS NULL OR runtime_id = $5)` clause, or flips the
            // OR to an AND, the effective predicate here changes with it.
            const usesOrGuard = /\(\s*\$5::text IS NULL OR runtime_id = \$5\s*\)/.test(sql);
            const usesAndGuard = /\$5::text IS NOT NULL AND runtime_id = \$5/.test(sql);
            const hasRuntimeGuard = sql.includes("runtime_id = $5");

            const matched = table.filter((row) => {
              if (row.tenant_id !== tenantId) return false;
              if (row.session_id !== sessionId) return false;
              if (row.user_id !== userId) return false;
              if (row.status === "terminated" || row.status === "error") return false;
              if (!hasRuntimeGuard) return true; // unscoped: any nonterminal row
              if (usesOrGuard) return runtimeId === null || row.runtime_id === runtimeId;
              if (usesAndGuard) return runtimeId !== null && row.runtime_id === runtimeId;
              // Some other guard shape — scope strictly to be safe.
              return row.runtime_id === runtimeId;
            });

            for (const row of matched) {
              row.status = status;
              row.updated_at = "2026-04-08T12:00:01.000Z";
            }

            return { rows: matched.map((r) => ({ ...r })), rowCount: matched.length };
          }
          throw new Error(`Unexpected ${sql}`);
        },
        async release() {}
      };
    }
  } as unknown as Pool;

  return { db, table };
}

test("RuntimeSessionStore.setStatus scoped to a runtime_id never clobbers a replacement row", async () => {
  // A stale runtime is being torn down while its replacement is already live.
  const { db, table } = makeSetStatusTable([
    { runtime_id: "rt-old", status: "active" },
    { runtime_id: "rt-new", status: "active" }
  ]);
  const store = new RuntimeSessionStore(db);

  const result = await store.setStatus("t", "s", "u", "terminated", "rt-old");

  // Only the targeted runtime's row is terminated...
  expect(result).toBeTruthy();
  expect(result!.runtimeId).toBe("rt-old");
  expect(result!.status).toBe("terminated");
  // ...and the freshly-inserted replacement is left untouched.
  expect(table.find((r) => r.runtime_id === "rt-new")!.status).toBe("active");
});

test("RuntimeSessionStore.setStatus without a runtime_id matches any nonterminal row for the session", async () => {
  const { db, table } = makeSetStatusTable([{ runtime_id: "rt-only", status: "active" }]);
  const store = new RuntimeSessionStore(db);

  const result = await store.setStatus("t", "s", "u", "inactive");

  expect(result).toBeTruthy();
  expect(result!.status).toBe("inactive");
  expect(table[0].status).toBe("inactive");
});

test("RuntimeSessionStore.setStatus never revives a terminated row", async () => {
  const { db } = makeSetStatusTable([{ runtime_id: "rt-old", status: "terminated" }]);
  const store = new RuntimeSessionStore(db);

  // Session-level (unscoped) form must still skip terminal rows.
  const result = await store.setStatus("t", "s", "u", "active");

  expect(result).toBe(null);
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
                  runtime_version: "1",
                  runtime_schema_version: "v2",
                  manifest_path: "/m",
                  manifest_metadata: {},
                  health_status: "healthy",
                  last_active_at: null,
                  started_at: null,
                  terminated_at: null,
                  lifecycle_metadata: {},
                  status: "active",
                  runtime_provider: "deep-agents",
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

function makeUpsertInput(): RuntimeSessionUpsertInput {
  return {
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimeProvider: "deep-agents" as const,
    workspacePath: "/tmp/runtime-1",
    runtimeVersion: "1.2.3",
    runtimeSchemaVersion: "v2",
    manifestPath: "/tmp/runtime-1/.framework/runtime-manifest.json",
    manifestMetadata: {
      manifestVersion: "v2",
      manifestHash: "manifest-hash",
      configBundleHash: "config-bundle-hash",
      sessionId: "session-1",
      userId: "user-1",
      generatedAt: "2026-04-08T12:00:00.000Z",
      workspacePath: "/tmp/runtime-1",
      runtimePolicy: {
        id: "cap-1",
        version: 1,
        hash: "policy-hash",
        enabledToolIds: [],
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        networkMode: "restricted",
        allowCommandExecution: true,
        autoApproveReadOnlyTools: false,
        webSearchMode: "disabled"
      },
      mcpServers: [],
      skills: [],
      configSources: {
        runtimePolicy: { id: "cap-1", version: 1, hash: "policy-hash" },
        skills: [],
        mcpServers: []
      },
      config: {
        skillsPath: "/skills",
        customSkillsEnabled: true,
        customMcpServersEnabled: true
      }
    },
    healthStatus: "healthy",
    lastActiveAt: "2026-04-08T12:00:00.000Z",
    startedAt: "2026-04-08T12:00:00.000Z",
    terminatedAt: null,
    lifecycleMetadata: { reason: "test" },
    status: "active"
  };
}

test("RuntimeSessionStore.upsert terminates the prior runtime before inserting the replacement", async () => {
  // On a runtime_id UPDATE miss (a fresh runtime for the session), upsert must
  // first terminate any prior non-terminal runtime for this session so a stale
  // 'active' row can't outlive its replacement — then INSERT, in that order.
  const db = new CaptureRuntimeSessionDatabase();
  const store = new RuntimeSessionStore(db as unknown as Pool);

  const record = await store.upsert(makeUpsertInput());

  const terminateIndex = db.calls.findIndex(
    (call) =>
      call.sql.includes("UPDATE runtime_sessions") && call.sql.includes("SET status = 'terminated'")
  );
  const insertIndex = db.calls.findIndex((call) => call.sql.includes("INSERT INTO runtime_sessions"));

  // The terminate UPDATE fired, scoped to the session id...
  expect(terminateIndex).toBeGreaterThanOrEqual(0);
  expect(db.calls[terminateIndex]!.params).toEqual(["session-1"]);
  // ...and it strictly precedes the INSERT of the replacement row.
  expect(insertIndex).toBeGreaterThan(terminateIndex);
  // The returned record reflects the freshly inserted row.
  expect(record.sessionId).toBe("session-1");
  expect(record.runtimeId).toBe("runtime-1");
  expect(record.status).toBe("active");
});

test("RuntimeSessionStore.upsert updates the existing runtime row in place (no terminate, no insert)", async () => {
  // Update-HIT path: when the runtime_id UPDATE matches an existing row, upsert
  // returns that updated row and does NOT run the terminate-previous or INSERT
  // branches. (The miss path is covered by the terminate-previous-runtime test.)
  const calls: QueryCall[] = [];
  const db = {
    async connect() {
      return {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
          calls.push({ sql, params });
          if (
            sql === "BEGIN" ||
            sql === "COMMIT" ||
            sql === "ROLLBACK" ||
            sql.startsWith("SELECT set_config")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("UPDATE runtime_sessions") && sql.includes("WHERE runtime_id =")) {
            // The runtime_id UPDATE HITS — return the updated row. The UPDATE
            // binds $1=tenant, $2=user, $3=runtime_id (WHERE), so build the row
            // from those rather than the INSERT-ordered helper.
            return {
              rows: [
                {
                  id: 1,
                  tenant_id: String(params[0]),
                  session_id: "session-1",
                  user_id: String(params[1]),
                  runtime_id: String(params[2]),
                  workspace_path: "/ws",
                  runtime_version: "1",
                  runtime_schema_version: "v2",
                  manifest_path: "/m",
                  manifest_metadata: {},
                  health_status: "healthy",
                  last_active_at: null,
                  started_at: null,
                  terminated_at: null,
                  lifecycle_metadata: {},
                  status: "active",
                  runtime_provider: "deep-agents",
                  created_at: "2026-04-08T12:00:00.000Z",
                  updated_at: "2026-04-08T12:00:00.000Z"
                }
              ],
              rowCount: 1
            };
          }
          throw new Error(`Unexpected query (update-hit path should not reach it): ${sql}`);
        },
        release: () => {}
      };
    }
  };
  const store = new RuntimeSessionStore(db as unknown as Pool);

  const record = await store.upsert(makeUpsertInput());

  // The returned record reflects the updated row...
  expect(record.sessionId).toBe("session-1");
  expect(record.runtimeId).toBe("runtime-1");
  expect(record.status).toBe("active");
  // ...and neither the terminate-previous nor the INSERT branch ran.
  expect(calls.some((c) => c.sql.includes("SET status = 'terminated'"))).toBe(false);
  expect(calls.some((c) => c.sql.includes("INSERT INTO runtime_sessions"))).toBe(false);
});
