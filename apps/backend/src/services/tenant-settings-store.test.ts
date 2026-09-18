import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import { TenantSettingsStore } from "./tenant-settings-store.js";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

class InMemoryTenantSettingsDatabase {
  private row: Record<string, unknown> | null = null;
  private nowCounter = 0;
  // Models pg_advisory_xact_lock: a mutex acquired in-transaction and
  // released on COMMIT/ROLLBACK, so concurrency tests exercise real blocking.
  private lockTail: Promise<void> = Promise.resolve();

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }> {
    let releaseLock: (() => void) | null = null;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          releaseLock?.();
          releaseLock = null;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          const previousHolder = this.lockTail;
          let release!: () => void;
          this.lockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previousHolder;
          releaseLock = release;
          return { rows: [], rowCount: 0 };
        }
        return this.query(sql, params);
      },
      release: () => {}
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("SELECT * FROM tenant_settings WHERE tenant_id = $1")) {
      if (!this.row || this.row.tenant_id !== params[0]) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [this.row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO tenant_settings")) {
      this.row = {
        tenant_id: String(params[0]),
        show_effort_selector: Boolean(params[1]),
        web_search_mode: String(params[2]),
        approval_policy: String(params[3]),
        approval_reviewer: String(params[4]),
        allow_command_execution: Boolean(params[5]),
        allow_user_token_forwarding: false,
        auto_approve_read_only_tools: Boolean(params[6]),
        policy_enforcement_mode: String(params[7]),
        developer_instructions: params[8] == null ? null : String(params[8]),
        enabled_tool_ids: JSON.parse(String(params[9])) as string[],
        enabled_mcp_server_ids: JSON.parse(String(params[10])) as string[],
        enabled_providers: JSON.parse(String(params[11])) as string[],
        enabled_model_ids: params[12] == null ? null : (JSON.parse(String(params[12])) as string[]),
        model_default_efforts: JSON.parse(String(params[13])) as Record<string, string>,
        version: 1, // Database version increments are covered by the Postgres suite.
        config_hash: String(params[14]),
        updated_at: new Date(Date.UTC(2026, 3, 15, 12, 0, this.nowCounter++)).toISOString()
      };

      return { rows: [this.row], rowCount: 1 };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  }
}

test("TenantSettingsStore.upsert preserves existing values for partial updates", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  await store.upsert("tenant-1", {
    approvalPolicy: "never",
    approvalReviewer: "guardian_subagent",
    allowCommandExecution: true,
    autoApproveReadOnlyTools: false,
    policyEnforcementMode: "enforce",
    webSearchMode: "live",
    developerInstructions: "Initial instructions",
    enabledToolIds: ["custom-tool"],
    enabledMcpServerIds: ["custom-server"]
  });

  const updated = await store.upsert("tenant-1", {
    developerInstructions: "Updated instructions"
  });

  expect(updated.approvalPolicy).toBe("never");
  expect(updated.showEffortSelector).toBe(false);
  expect(updated.webSearchMode).toBe("live");
  expect(updated.approvalReviewer).toBe("guardian_subagent");
  expect(updated.allowCommandExecution).toBe(true);
  expect(updated.autoApproveReadOnlyTools).toBe(false);
  expect(updated.policyEnforcementMode).toBe("enforce");
  expect(updated.developerInstructions).toBe("Updated instructions");
  expect(updated.enabledToolIds).toEqual(["custom-tool"]);
  expect(updated.enabledMcpServerIds).toEqual(["custom-server"]);
});

test("TenantSettingsStore.upsert serializes concurrent partial updates without losing either write", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  await store.upsert("tenant-c", {
    developerInstructions: "initial",
    webSearchMode: "live"
  });

  // Two partial updates racing on different fields. Without per-tenant
  // serialization both read the same baseline row and the second write
  // resurrects stale values over the first.
  await Promise.all([
    store.upsert("tenant-c", { developerInstructions: "from writer A" }),
    store.upsert("tenant-c", { showEffortSelector: true })
  ]);

  const final = await store.get("tenant-c");
  expect(final?.developerInstructions).toBe("from writer A");
  expect(final?.showEffortSelector).toBe(true);
  expect(final?.webSearchMode).toBe("live");
});

test("TenantSettingsStore.upsert applies smart defaults for a new tenant", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  const created = await store.upsert("tenant-2", {
    developerInstructions: "Tenant-specific instructions"
  });

  expect(created.approvalPolicy).toBe("on-request");
  expect(created.showEffortSelector).toBe(false);
  expect(created.webSearchMode).toBe("disabled");
  expect(created.approvalReviewer).toBe("user");
  expect(created.allowCommandExecution).toBe(false);
  expect(created.autoApproveReadOnlyTools).toBe(true);
  expect(created.policyEnforcementMode).toBe("monitor");
  expect(created.developerInstructions).toBe("Tenant-specific instructions");
  expect(created.enabledToolIds).toEqual([
        "managed-session-context",
        "session_context",
        "list_artifacts",
        "read_text_artifact",
        "read_skill_corpus",
        "write_artifact",
        "memory_search",
        "memory_save",
        "memory_delete",
        "project_list_files",
        "project_read_file",
        "project_get_conflict_context",
        "project_reconcile_conflict",
        "project_write_file"
      ]);
  expect(created.enabledMcpServerIds).toEqual(["managed-session-context"]);
  expect(created.version).toBe(1);
});

test("TenantSettingsStore.get returns null when no row exists", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.get("tenant-missing");
  expect(result).toBe(null);
});

test("TenantSettingsStore.upsert persists showEffortSelector", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  const created = await store.upsert("tenant-4", {
    showEffortSelector: true
  });

  expect(created.showEffortSelector).toBe(true);

  const updated = await store.upsert("tenant-4", {
    showEffortSelector: false
  });

  expect(updated.showEffortSelector).toBe(false);
});

test("TenantSettingsStore.upsert persists webSearchMode and preserves it across partial updates", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  const created = await store.upsert("tenant-5", {
    webSearchMode: "cached"
  });

  expect(created.webSearchMode).toBe("cached");

  // A partial update that omits webSearchMode keeps the stored value.
  const preserved = await store.upsert("tenant-5", {
    showEffortSelector: true
  });

  expect(preserved.webSearchMode).toBe("cached");

  const updated = await store.upsert("tenant-5", {
    webSearchMode: "disabled"
  });

  expect(updated.webSearchMode).toBe("disabled");
});
