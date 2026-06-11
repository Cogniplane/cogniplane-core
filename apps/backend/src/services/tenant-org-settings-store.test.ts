import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { decrypt } from "../lib/crypto-utils.js";
import { TenantOrgSettingsStore } from "./tenant-org-settings-store.js";
import { DEFAULT_PII_PROTECTION, parsePiiProtection } from "./pii/pii-policy.js";

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

type Row = {
  tenant_id: string;
  openai_api_key_encrypted: string | null;
  anthropic_api_key_encrypted: string | null;
  skill_marketplace_manifest_url: string | null;
  pii_protection: unknown;
  updated_at: string;
};

// Minimal in-memory pg fake: parses the INSERT/UPDATE column list emitted by
// the store's lazy upsert and applies it against a single row keyed by tenant.
class FakeOrgSettingsDb {
  readonly rows = new Map<string, Row>();

  async query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config('app.current_tenant_id'")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith("SELECT tenant_id")) {
      const tenantId = String(values[0]);
      const row = this.rows.get(tenantId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.startsWith("SELECT openai_api_key_encrypted")) {
      const tenantId = String(values[0]);
      const row = this.rows.get(tenantId);
      return {
        rows: row ? [{ value: row.openai_api_key_encrypted }] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.startsWith("SELECT anthropic_api_key_encrypted")) {
      const tenantId = String(values[0]);
      const row = this.rows.get(tenantId);
      return {
        rows: row ? [{ value: row.anthropic_api_key_encrypted }] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.startsWith("INSERT INTO tenant_org_settings")) {
      const columns = parseInsertColumns(text);
      const tenantId = String(values[0]);
      const existing = this.rows.get(tenantId);
      const next: Row = existing ?? {
        tenant_id: tenantId,
        openai_api_key_encrypted: null,
        anthropic_api_key_encrypted: null,
        skill_marketplace_manifest_url: null,
        pii_protection: null,
        updated_at: new Date().toISOString()
      };
      for (let i = 1; i < columns.length; i++) {
        const col = columns[i] as keyof Row;
        const value = values[i];
        if (col === "pii_protection") {
          (next as Record<string, unknown>)[col] = value == null ? null : JSON.parse(String(value));
        } else {
          (next as Record<string, unknown>)[col] = value as never;
        }
      }
      next.updated_at = new Date().toISOString();
      this.rows.set(tenantId, next);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  }

  async connect() {
    return {
      query: (text: string, values?: unknown[]) => this.query(text, values),
      release: () => {}
    };
  }
}

function parseInsertColumns(sql: string): string[] {
  const match = /INSERT INTO tenant_org_settings \(([^)]+)\)/.exec(sql);
  if (!match) throw new Error("malformed insert in test");
  return match[1].split(",").map((s) => s.trim());
}

function makeStore() {
  const db = new FakeOrgSettingsDb();
  const store = new TenantOrgSettingsStore(db as unknown as Pool, SECRET);
  return { db, store };
}

test("get returns defaults when no row exists", async () => {
  const { store } = makeStore();
  const record = await store.get("tenant-1");
  expect(record.tenantId).toBe("tenant-1");
  expect(record.hasOpenaiApiKey).toBe(false);
  expect(record.hasAnthropicApiKey).toBe(false);
  expect(record.skillMarketplaceManifestUrl).toBe(null);
  expect(record.piiProtection).toEqual(DEFAULT_PII_PROTECTION);
});

test("setApiKeys encrypts before persisting and round-trips on read", async () => {
  const { db, store } = makeStore();
  await store.setApiKeys("tenant-1", {
    openaiApiKey: "sk-openai-secret",
    anthropicApiKey: "sk-ant-secret"
  });

  // Stored values are not the plaintext.
  const row = db.rows.get("tenant-1")!;
  expect(row.openai_api_key_encrypted).not.toBe("sk-openai-secret");
  expect(row.anthropic_api_key_encrypted).not.toBe("sk-ant-secret");
  // ...but the encryption round-trips through the same secret.
  expect(decrypt(row.openai_api_key_encrypted!, SECRET)).toBe("sk-openai-secret");

  // Public getters surface the original plaintext.
  expect(await store.getDecryptedOpenaiApiKey("tenant-1")).toBe("sk-openai-secret");
  expect(await store.getDecryptedAnthropicApiKey("tenant-1")).toBe("sk-ant-secret");

  const record = await store.get("tenant-1");
  expect(record.hasOpenaiApiKey).toBe(true);
  expect(record.hasAnthropicApiKey).toBe(true);
});

test("setApiKeys with explicit null clears the column", async () => {
  const { store } = makeStore();
  await store.setApiKeys("tenant-1", { openaiApiKey: "sk-original" });
  expect(await store.getDecryptedOpenaiApiKey("tenant-1")).toBe("sk-original");

  await store.setApiKeys("tenant-1", { openaiApiKey: null });
  expect(await store.getDecryptedOpenaiApiKey("tenant-1")).toBe(null);
});

test("setApiKeys leaves untouched fields alone", async () => {
  const { store } = makeStore();
  await store.setApiKeys("tenant-1", {
    openaiApiKey: "sk-openai",
    anthropicApiKey: "sk-anthropic"
  });

  // Update only openai; anthropic must not be cleared.
  await store.setApiKeys("tenant-1", { openaiApiKey: "sk-openai-rotated" });
  expect(await store.getDecryptedOpenaiApiKey("tenant-1")).toBe("sk-openai-rotated");
  expect(await store.getDecryptedAnthropicApiKey("tenant-1")).toBe("sk-anthropic");
});

test("setMarketplaceUrl persists the value and a subsequent setPiiProtection does not clear it", async () => {
  const { store } = makeStore();
  await store.setMarketplaceUrl("tenant-1", "https://example.com/manifest.json");
  await store.setPiiProtection("tenant-1", parsePiiProtection({}));

  const record = await store.get("tenant-1");
  expect(record.skillMarketplaceManifestUrl).toBe("https://example.com/manifest.json");
});

test("setPiiProtection round-trips through the JSONB column", async () => {
  const { store } = makeStore();
  const policy = parsePiiProtection({
    enabled: true,
    mode: "detect",
    rawRetention: "never",
    provider: { type: "openai-compatible", model: "meta/llama-guard" },
    scopes: { chatPrompts: true, uploads: true, microsoftImports: false },
    actions: { reportToAdmins: true },
    detectors: { useRulesFirst: true, entityTypes: ["email"] }
  });
  await store.setPiiProtection("tenant-1", policy);

  const record = await store.get("tenant-1");
  expect(record.piiProtection).toEqual(policy);
});
