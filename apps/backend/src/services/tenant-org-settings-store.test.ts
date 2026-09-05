import { test, expect } from "vitest";
import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";

import type { Pool } from "../lib/db.js";
import { decrypt } from "../lib/crypto-utils.js";
import { TenantOrgSettingsStore } from "./tenant-org-settings-store.js";
import { parsePiiProtection } from "./pii/pii-policy.js";

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

type Row = {
  tenant_id: string;
  anthropic_api_key_encrypted: string | null;
  openai_api_key_encrypted: string | null;
  google_api_key_encrypted: string | null;
  openrouter_api_key_encrypted: string | null;
  zai_api_key_encrypted: string | null;
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

    // readEncryptedKey: `SELECT <column> AS value FROM ...` for any provider
    // column.
    const keyColMatch = /^SELECT (\w+_api_key_encrypted) AS value/.exec(text);
    if (keyColMatch) {
      const column = keyColMatch[1] as keyof Row;
      const tenantId = String(values[0]);
      const row = this.rows.get(tenantId);
      return {
        rows: row ? [{ value: row[column] ?? null }] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.startsWith("INSERT INTO tenant_org_settings")) {
      const columns = parseInsertColumns(text);
      const tenantId = String(values[0]);
      const existing = this.rows.get(tenantId);
      const next: Row = existing ?? {
        tenant_id: tenantId,
        anthropic_api_key_encrypted: null,
        openai_api_key_encrypted: null,
        google_api_key_encrypted: null,
        openrouter_api_key_encrypted: null,
        zai_api_key_encrypted: null,
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
  expect(record.providerKeys.anthropic).toBe(false);
  expect(record.skillMarketplaceManifestUrl).toBe(null);
  expect(record.piiProtection).toEqual(DEFAULT_PII_PROTECTION);
});

test("setApiKey encrypts before persisting and round-trips on read", async () => {
  const { db, store } = makeStore();
  await store.setApiKey("tenant-1", "anthropic", "sk-ant-secret");

  // Stored value is not the plaintext...
  const row = db.rows.get("tenant-1")!;
  expect(row.anthropic_api_key_encrypted).not.toBe("sk-ant-secret");
  // ...but the encryption round-trips through the same secret.
  expect(decrypt(row.anthropic_api_key_encrypted!, SECRET)).toBe("sk-ant-secret");

  // Public getter surfaces the original plaintext.
  expect(await store.getDecryptedApiKey("tenant-1", "anthropic")).toBe("sk-ant-secret");

  const record = await store.get("tenant-1");
  expect(record.providerKeys.anthropic).toBe(true);
});

test("setApiKey persists per-provider keys independently and surfaces the presence map", async () => {
  const { store } = makeStore();
  await store.setApiKey("tenant-1", "openai", "sk-openai");
  await store.setApiKey("tenant-1", "openrouter", "sk-or-key");

  expect(await store.getDecryptedApiKey("tenant-1", "openai")).toBe("sk-openai");
  expect(await store.getDecryptedApiKey("tenant-1", "openrouter")).toBe("sk-or-key");
  expect(await store.getDecryptedApiKey("tenant-1", "anthropic")).toBe(null);

  const record = await store.get("tenant-1");
  expect(record.providerKeys).toEqual({
    anthropic: false,
    openai: true,
    google: false,
    openrouter: true,
    zai: false
  });
});

test("setApiKey with null clears just that provider", async () => {
  const { store } = makeStore();
  await store.setApiKey("tenant-1", "google", "AIza-google");
  await store.setApiKey("tenant-1", "anthropic", "sk-ant");
  await store.setApiKey("tenant-1", "google", null);

  expect(await store.getDecryptedApiKey("tenant-1", "google")).toBe(null);
  expect(await store.getDecryptedApiKey("tenant-1", "anthropic")).toBe("sk-ant");
});

test("setApiKey leaves untouched fields alone", async () => {
  const { store } = makeStore();
  await store.setApiKey("tenant-1", "anthropic", "sk-anthropic");

  // A marketplace-url update must not clear the key.
  await store.setMarketplaceUrl("tenant-1", "https://example.com/manifest.json");
  expect(await store.getDecryptedApiKey("tenant-1", "anthropic")).toBe("sk-anthropic");
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
