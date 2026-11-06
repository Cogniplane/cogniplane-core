import { test, expect, vi } from "vitest";
import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";

import type { Pool } from "../lib/db.js";
import { decrypt } from "../lib/crypto-utils.js";
import { PiiSettingsConflictError, TenantOrgSettingsStore } from "./tenant-org-settings-store.js";
import { PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";
import { WeakerChangeError } from "./weaker-change-error.js";

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
  pii_protection_revision: number;
  updated_at: string;
};

// Minimal in-memory pg fake: parses the INSERT/UPDATE column list emitted by
// the store's lazy upsert and applies it against a single row keyed by tenant.
class FakeOrgSettingsDb {
  readonly rows = new Map<string, Row>();
  readonly statements: string[] = [];

  async query(text: string, values: unknown[] = []) {
    this.statements.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    if (text.includes("INSERT INTO audit_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config('app.current_tenant_id'")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith("SELECT pii_protection, pii_protection_revision")) {
      const row = this.rows.get(String(values[0]));
      return {
        rows: row ? [{ pii_protection: row.pii_protection, pii_protection_revision: row.pii_protection_revision }] : [],
        rowCount: row ? 1 : 0
      };
    }
    // The PII save: it sets the policy and adds 1 to the revision.
    if (text.startsWith("UPDATE tenant_org_settings") && text.includes("SET pii_protection = $2::jsonb")) {
      const row = this.rows.get(String(values[0]));
      if (!row) return { rows: [], rowCount: 0 };
      row.pii_protection = JSON.parse(String(values[1]));
      if (text.includes("pii_protection_revision = pii_protection_revision + 1")) row.pii_protection_revision += 1;
      row.updated_at = new Date().toISOString();
      return { rows: [{ pii_protection_revision: row.pii_protection_revision }], rowCount: 1 };
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
        pii_protection_revision: 0,
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
  expect(record.storedPiiProtection).toBeNull();
  expect(record.piiProtectionRevision).toBe(0);
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

test("a setter writes its audit event inside the settings transaction", async () => {
  const { db, store } = makeStore();
  await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, expectedRevision: 0, audit: (stored) => ({
    tenantId: "tenant-1",
    sessionId: null,
    userId: "admin-1",
    type: "tenant.pii_protection.updated",
    payload: { piiProtection: stored }
  }) });

  const writes = db.statements.filter((statement) => !statement.startsWith("SELECT set_config"));
  expect(writes).toEqual([
    "BEGIN",
    // Creates the row first, so two first saves cannot both read no row.
    "INSERT INTO tenant_org_settings",
    // Locks the row; the revision check uses this read.
    "SELECT pii_protection, pii_protection_revision",
    "UPDATE tenant_org_settings SET",
    "INSERT INTO audit_events",
    "COMMIT"
  ]);
});

function piiAudit(stored: unknown) {
  return {
    tenantId: "tenant-1",
    sessionId: null,
    userId: "admin-1",
    type: "tenant.pii_protection.updated" as const,
    payload: { piiProtection: stored }
  };
}

test("setPiiProtection with the stored revision saves the policy and adds 1 to the revision", async () => {
  const { db, store } = makeStore();
  // A tenant with no row has revision 0.
  expect(await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, expectedRevision: 0 }))
    .toEqual({ stored: DEFAULT_PII_PROTECTION, revision: 1 });

  const next = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" as const };
  const audit = vi.fn(piiAudit);
  expect(await store.setPiiProtection("tenant-1", next, { ...PII_SAVE_ALLOWED, expectedRevision: 1, audit }))
    .toEqual({ stored: next, revision: 2 });

  expect(db.rows.get("tenant-1")?.pii_protection).toEqual(next);
  expect(audit).toHaveBeenCalledWith(next, 2, []);
  const record = await store.get("tenant-1");
  expect(record.storedPiiProtection).toEqual(next);
  expect(record.piiProtectionRevision).toBe(2);
});

test("setPiiProtection with an older revision throws and writes neither the policy nor an audit event", async () => {
  const { db, store } = makeStore();
  const first = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" as const };
  await store.setPiiProtection("tenant-1", first, PII_SAVE_ALLOWED);
  db.statements.length = 0;

  const audit = vi.fn(piiAudit);
  await expect(store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, expectedRevision: 0, audit }))
    .rejects.toBeInstanceOf(PiiSettingsConflictError);

  expect(audit).not.toHaveBeenCalled();
  expect(db.statements.filter((statement) => !statement.startsWith("SELECT set_config"))).toEqual([
    "BEGIN",
    "INSERT INTO tenant_org_settings",
    "SELECT pii_protection, pii_protection_revision",
    "ROLLBACK"
  ]);
  expect(db.rows.get("tenant-1")).toMatchObject({ pii_protection: first, pii_protection_revision: 1 });
});

test("setPiiProtection stops with a clear error when the locked read finds no row", async () => {
  const { db, store } = makeStore();
  // A tenant-scope fault: the row that the insert made is not visible.
  const query = db.query.bind(db);
  db.query = async (text: string, values: unknown[] = []) =>
    text.startsWith("SELECT pii_protection, pii_protection_revision") ? { rows: [], rowCount: 0 } : query(text, values);
  const audit = vi.fn(piiAudit);

  await expect(store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, audit }))
    .rejects.toThrow("tenant_org_settings row not visible for tenant tenant-1");
  expect(audit).not.toHaveBeenCalled();
  expect(db.statements.at(-1)).toBe("ROLLBACK");
});

test("setPiiProtection without a revision saves with no check (compatibility path) and adds 1", async () => {
  const { db, store } = makeStore();
  await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, PII_SAVE_ALLOWED);
  await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, PII_SAVE_ALLOWED);
  const next = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" as const };

  expect(await store.setPiiProtection("tenant-1", next, PII_SAVE_ALLOWED)).toEqual({ stored: next, revision: 3 });
  expect(db.rows.get("tenant-1")).toMatchObject({ pii_protection: next, pii_protection_revision: 3 });
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
  await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, PII_SAVE_ALLOWED);

  const record = await store.get("tenant-1");
  expect(record.skillMarketplaceManifestUrl).toBe("https://example.com/manifest.json");
});

test("setPiiProtection keeps raw stored scope keys that the save does not name", async () => {
  const { db, store } = makeStore();
  const first = { ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true, uploads: true, retiredImports: false, junk: "x" } };
  await store.setPiiProtection("tenant-1", first as never, PII_SAVE_ALLOWED);
  const next = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" as const, scopes: { chatPrompts: false, uploads: true } };
  const { stored } = await store.setPiiProtection("tenant-1", next, PII_SAVE_ALLOWED);

  const expected = { ...next, scopes: { chatPrompts: false, uploads: true, retiredImports: false, junk: "x" } };
  expect(stored).toEqual(expected);
  expect(db.rows.get("tenant-1")?.pii_protection).toEqual(expected);
  expect((await store.get("tenant-1")).storedPiiProtection).toEqual(expected);
});

// A PII save is classified against the locked row, after the revision check
// (pii-weakening.ts decides "weaker"). A weaker save that the caller did not
// allow writes nothing; the caller then asks for step-up and saves again.
test("setPiiProtection refuses a weaker save that is not allowed, after the revision check, and writes nothing", async () => {
  const { db, store } = makeStore();
  const on = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" as const };
  await store.setPiiProtection("tenant-1", on, PII_SAVE_ALLOWED);
  db.statements.length = 0;

  const weakerFields = vi.fn(() => ["Protection"]);
  const audit = vi.fn(piiAudit);
  // A stale save answers with the conflict before the classification.
  await expect(store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { expectedRevision: 0, weakerFields, allowWeaker: false, audit }))
    .rejects.toBeInstanceOf(PiiSettingsConflictError);
  expect(weakerFields).not.toHaveBeenCalled();

  await expect(store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { expectedRevision: 1, weakerFields, allowWeaker: false, audit }))
    .rejects.toBeInstanceOf(WeakerChangeError);
  // The classification got the stored policy and the policy to store.
  expect(weakerFields).toHaveBeenCalledWith(on, DEFAULT_PII_PROTECTION);
  expect(audit).not.toHaveBeenCalled();
  expect(db.statements.at(-1)).toBe("ROLLBACK");
  expect(db.rows.get("tenant-1")).toMatchObject({ pii_protection: on, pii_protection_revision: 1 });

  // After step-up the same save, with the same revision, is stored, and the
  // audit event gets the weaker fields.
  expect(await store.setPiiProtection("tenant-1", DEFAULT_PII_PROTECTION, { expectedRevision: 1, weakerFields, allowWeaker: true, audit }))
    .toEqual({ stored: DEFAULT_PII_PROTECTION, revision: 2 });
  expect(audit).toHaveBeenCalledWith(DEFAULT_PII_PROTECTION, 2, ["Protection"]);
});
