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
      const previousVersion =
        this.row && this.row.tenant_id === params[0]
          ? Number(this.row.version)
          : 0;

      this.row = {
        tenant_id: String(params[0]),
        enabled_runtime_providers: JSON.parse(String(params[1])) as string[],
        show_effort_selector: Boolean(params[2]),
        approval_policy: String(params[3]),
        approval_reviewer: String(params[4]),
        allow_command_execution: Boolean(params[5]),
        allow_user_token_forwarding: Boolean(params[6]),
        auto_approve_read_only_tools: Boolean(params[7]),
        developer_instructions: params[8] == null ? null : String(params[8]),
        enabled_tool_ids: JSON.parse(String(params[9])) as string[],
        enabled_mcp_server_ids: JSON.parse(String(params[10])) as string[],
        skill_judge_enabled: Boolean(params[11]),
        skill_judge_provider: params[12] == null ? null : String(params[12]),
        skill_judge_model: params[13] == null ? null : String(params[13]),
        skill_judge_mode: String(params[14]),
        version: previousVersion + 1,
        config_hash: String(params[15]),
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
    allowUserTokenForwarding: false,
    autoApproveReadOnlyTools: false,
    developerInstructions: "Initial instructions",
    enabledToolIds: ["custom-tool"],
    enabledMcpServerIds: ["custom-server"]
  });

  const updated = await store.upsert("tenant-1", {
    developerInstructions: "Updated instructions"
  });

  expect(updated.approvalPolicy).toBe("never");
  expect(updated.enabledRuntimeProviders).toEqual(["codex"]);
  expect(updated.showEffortSelector).toBe(false);
  expect(updated.approvalReviewer).toBe("guardian_subagent");
  expect(updated.allowCommandExecution).toBe(true);
  expect(updated.allowUserTokenForwarding).toBe(false);
  expect(updated.autoApproveReadOnlyTools).toBe(false);
  expect(updated.developerInstructions).toBe("Updated instructions");
  expect(updated.enabledToolIds).toEqual(["custom-tool"]);
  expect(updated.enabledMcpServerIds).toEqual(["custom-server"]);
  expect(updated.version).toBe(2);
});

test("TenantSettingsStore.upsert applies smart defaults for a new tenant", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  const created = await store.upsert("tenant-2", {
    developerInstructions: "Tenant-specific instructions"
  });

  expect(created.approvalPolicy).toBe("on-request");
  expect(created.enabledRuntimeProviders).toEqual(["codex"]);
  expect(created.showEffortSelector).toBe(false);
  expect(created.approvalReviewer).toBe("user");
  expect(created.allowCommandExecution).toBe(false);
  expect(created.allowUserTokenForwarding).toBe(true);
  expect(created.autoApproveReadOnlyTools).toBe(true);
  expect(created.developerInstructions).toBe("Tenant-specific instructions");
  expect(created.enabledToolIds).toEqual([
        "managed-session-context",
        "session_context",
        "list_artifacts",
        "read_text_artifact",
        "write_artifact"
      ]);
  expect(created.enabledMcpServerIds).toEqual(["managed-session-context"]);
  expect(created.version).toBe(1);
});

test("TenantSettingsStore.upsert derives the default provider from the first enabled provider", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);

  const created = await store.upsert("tenant-3", {
    enabledRuntimeProviders: ["claude-code", "codex"]
  });

  expect(created.runtimeProvider).toBe("claude-code");
  expect(created.enabledRuntimeProviders).toEqual(["claude-code", "codex"]);

  const updated = await store.upsert("tenant-3", {
    enabledRuntimeProviders: ["codex"]
  });

  expect(updated.runtimeProvider).toBe("codex");
  expect(updated.enabledRuntimeProviders).toEqual(["codex"]);
});

test("TenantSettingsStore.get returns null when no row exists", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.get("tenant-missing");
  expect(result).toBe(null);
});

test("TenantSettingsStore.upsert rejects empty enabledRuntimeProviders", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  await expect(() => store.upsert("tenant-x", { enabledRuntimeProviders: [] })).rejects.toThrow(/At least one runtime provider/);
});

test("TenantSettingsStore.upsert rejects providers list with only unknown values", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  await expect(() =>
        store.upsert("tenant-y", {
          enabledRuntimeProviders: ["does-not-exist" as never]
        })).rejects.toThrow(/At least one runtime provider/);
});

test("TenantSettingsStore.upsert deduplicates and normalizes providers", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.upsert("tenant-norm", {
    enabledRuntimeProviders: ["codex", "claude-code", "codex"] as never
  });
  // Dupes dropped; original order preserved
  expect(result.enabledRuntimeProviders).toEqual(["codex", "claude-code"]);
  expect(result.runtimeProvider).toBe("codex");
});

test("TenantSettingsStore.upsert persists skill judge config", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.upsert("tenant-judge", {
    skillJudgeEnabled: true,
    skillJudgeProvider: "anthropic",
    skillJudgeModel: "claude-sonnet",
    skillJudgeMode: "batch"
  });
  expect(result.skillJudgeEnabled).toBe(true);
  expect(result.skillJudgeProvider).toBe("anthropic");
  expect(result.skillJudgeModel).toBe("claude-sonnet");
  expect(result.skillJudgeMode).toBe("batch");
});

test("TenantSettingsStore.upsert: skillJudgeProvider invalid value coerces to null", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.upsert("tenant-sk", {
    skillJudgeProvider: "garbage" as never
  });
  expect(result.skillJudgeProvider).toBe(null);
});

test("TenantSettingsStore.upsert: invalid skillJudgeMode falls back to 'sync'", async () => {
  const db = new InMemoryTenantSettingsDatabase();
  const store = new TenantSettingsStore(db as unknown as Pool);
  const result = await store.upsert("tenant-sm", {
    skillJudgeMode: "weird" as never
  });
  expect(result.skillJudgeMode).toBe("sync");
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
