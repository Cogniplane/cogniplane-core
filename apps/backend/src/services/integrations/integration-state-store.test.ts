import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { IntegrationStateStore } from "./integration-state-store.js";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

class InMemoryIntegrationDatabase {
  private rows: Record<string, unknown>[] = [];
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

    if (sql.includes("FROM tenant_integrations") && sql.includes("integration_id = $2")) {
      const match = this.rows.find(
        (row) => row.tenant_id === params[0] && row.integration_id === params[1]
      );
      return match ? { rows: [match], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.includes("FROM tenant_integrations") && sql.includes("ORDER BY integration_id")) {
      const matches = this.rows
        .filter((row) => row.tenant_id === params[0])
        .sort((a, b) => String(a.integration_id).localeCompare(String(b.integration_id)));
      return { rows: matches, rowCount: matches.length };
    }

    if (sql.includes("INSERT INTO tenant_integrations")) {
      const idx = this.rows.findIndex(
        (row) => row.tenant_id === params[0] && row.integration_id === params[1]
      );
      const now = new Date(Date.UTC(2026, 3, 25, 12, 0, this.nowCounter++)).toISOString();

      const next: Record<string, unknown> = {
        tenant_id: String(params[0]),
        integration_id: String(params[1]),
        reads_enabled: Boolean(params[2]),
        writes_enabled: Boolean(params[3]),
        config_json: JSON.parse(String(params[4])) as Record<string, unknown>,
        updated_by: params[5] == null ? null : String(params[5]),
        created_at: idx >= 0 ? this.rows[idx].created_at : now,
        updated_at: now
      };

      if (idx >= 0) {
        this.rows[idx] = next;
      } else {
        this.rows.push(next);
      }

      return { rows: [next], rowCount: 1 };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  }
}

test("IntegrationStateStore.upsert inserts a new row with defaults", async () => {
  const db = new InMemoryIntegrationDatabase();
  const store = new IntegrationStateStore(db as unknown as Pool);

  const inserted = await store.upsert("tenant-1", "notion", {
    readsEnabled: true,
    updatedBy: "user-1"
  });

  expect(inserted.tenantId).toBe("tenant-1");
  expect(inserted.integrationId).toBe("notion");
  expect(inserted.readsEnabled).toBe(true);
  expect(inserted.writesEnabled).toBe(false);
  expect(inserted.config).toEqual({});
  expect(inserted.updatedBy).toBe("user-1");
});

test("IntegrationStateStore.upsert preserves untouched fields on partial update", async () => {
  const db = new InMemoryIntegrationDatabase();
  const store = new IntegrationStateStore(db as unknown as Pool);

  await store.upsert("tenant-1", "microsoft", {
    readsEnabled: true,
    writesEnabled: true,
    config: { clientId: "abc", entraTenantId: "xyz" },
    updatedBy: "admin-1"
  });

  const patched = await store.upsert("tenant-1", "microsoft", {
    writesEnabled: false,
    updatedBy: "admin-2"
  });

  expect(patched.readsEnabled).toBe(true);
  expect(patched.writesEnabled).toBe(false);
  expect(patched.config).toEqual({ clientId: "abc", entraTenantId: "xyz" });
  expect(patched.updatedBy).toBe("admin-2");
});

test("IntegrationStateStore.list returns all rows for a tenant ordered by integration id", async () => {
  const db = new InMemoryIntegrationDatabase();
  const store = new IntegrationStateStore(db as unknown as Pool);

  await store.upsert("tenant-1", "notion", { readsEnabled: true });
  await store.upsert("tenant-1", "github", { writesEnabled: true });
  await store.upsert("tenant-2", "notion", { readsEnabled: true });

  const rows = await store.list("tenant-1");
  expect(rows.map((r) => r.integrationId)).toEqual(["github", "notion"]);
});

test("IntegrationStateStore.clearConfig resets toggles and config", async () => {
  const db = new InMemoryIntegrationDatabase();
  const store = new IntegrationStateStore(db as unknown as Pool);

  await store.upsert("tenant-1", "microsoft", {
    readsEnabled: true,
    writesEnabled: true,
    config: { clientId: "abc" },
    updatedBy: "admin-1"
  });

  const cleared = await store.clearConfig("tenant-1", "microsoft", "admin-2");

  expect(cleared.readsEnabled).toBe(false);
  expect(cleared.writesEnabled).toBe(false);
  expect(cleared.config).toEqual({});
  expect(cleared.updatedBy).toBe("admin-2");
});

test("IntegrationStateStore.get returns null for unknown integration", async () => {
  const db = new InMemoryIntegrationDatabase();
  const store = new IntegrationStateStore(db as unknown as Pool);

  const result = await store.get("tenant-1", "missing");
  expect(result).toBe(null);
});
