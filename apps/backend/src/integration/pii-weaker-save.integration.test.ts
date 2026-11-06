import { describe, expect, test } from "vitest";

import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
import { resolvePiiPolicy } from "../services/pii/pii-policy.js";
import { weakerPiiFields } from "../services/pii/pii-weakening.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";
import { PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

// A PII save is classified against the row that the save locks
// (TenantOrgSettingsStore.setPiiProtection, pii-weakening.ts). A
// classification against a copy read before the lock would let a save with
// no step-up write back an older, weaker policy over a stronger one that
// another admin saved meanwhile.

const ENCRYPTION_SECRET = "integration-pii-weaker-secret-value";
const DETECT: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" };
const BLOCK: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" };

function classified(allowWeaker: boolean) {
  const registry = new PiiImportScopeRegistry();
  return { weakerFields: (stored: unknown, next: PiiProtectionSettings) => weakerPiiFields(stored, next, registry), allowWeaker };
}

async function tenantWith(policy: PiiProtectionSettings) {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId, "owner");
  const store = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
  await store.setPiiProtection(tenantId, policy, PII_SAVE_ALLOWED);
  return { tenantId, userId, store };
}

async function stored(tenantId: string) {
  const row = await superuserPool().query<{ pii_protection: unknown; pii_protection_revision: number }>(
    "SELECT pii_protection, pii_protection_revision FROM tenant_org_settings WHERE tenant_id = $1", [tenantId]);
  return row.rows[0]!;
}

describe.skipIf(!adminDatabaseUrl())("PII saves that make the protection weaker", () => {
  test("a save is classified against the row after a concurrent save commits", async () => {
    const { tenantId, store } = await tenantWith(DETECT);

    // Another admin's save is open: block mode, not committed yet.
    const other = await superuserPool().connect();
    let committed = false;
    let save: Promise<unknown> | undefined;
    try {
      await other.query("BEGIN");
      const pid = (await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await other.query(
        `UPDATE tenant_org_settings SET pii_protection = $2::jsonb, pii_protection_revision = pii_protection_revision + 1
         WHERE tenant_id = $1`, [tenantId, JSON.stringify(BLOCK)]);

      // A save of the detect policy with no step-up: against the copy before
      // the other save it changes nothing; against the locked row it is weaker.
      save = store.setPiiProtection(tenantId, DETECT, classified(false));
      save.catch(() => undefined);
      for (let attempt = 0; ; attempt += 1) {
        const blocked = await superuserPool().query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
        if (blocked.rowCount) break;
        if (attempt > 200) throw new Error("the save never waited for the other save");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await other.query("COMMIT");
      committed = true;
      await expect(save).rejects.toBeInstanceOf(WeakerChangeError);
    } finally {
      if (!committed) await other.query("ROLLBACK").catch(() => undefined);
      other.release();
      await save?.catch(() => undefined);
    }

    expect(await stored(tenantId)).toEqual({ pii_protection: BLOCK, pii_protection_revision: 2 });
  });

  test("a refused save writes nothing; the same save with step-up and the same revision is stored", async () => {
    const { tenantId, userId, store } = await tenantWith(BLOCK);
    const audit = (policy: PiiProtectionSettings, revision: number, weakerFields: string[]) => ({
      tenantId, sessionId: null, userId, type: "tenant.pii_protection.updated" as const, payload: { revision, weakerFields }
    });

    await expect(store.setPiiProtection(tenantId, DEFAULT_PII_PROTECTION, { expectedRevision: 1, ...classified(false), audit }))
      .rejects.toBeInstanceOf(WeakerChangeError);
    expect(await stored(tenantId)).toEqual({ pii_protection: BLOCK, pii_protection_revision: 1 });
    const none = await superuserPool().query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.pii_protection.updated'", [tenantId]);
    expect(none.rowCount).toBe(0);

    expect(await store.setPiiProtection(tenantId, DEFAULT_PII_PROTECTION, { expectedRevision: 1, ...classified(true), audit }))
      .toMatchObject({ revision: 2 });
    const events = await superuserPool().query<{ payload: unknown }>(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.pii_protection.updated'", [tenantId]);
    expect(events.rows.map((row) => row.payload)).toEqual([{ revision: 2, weakerFields: ["Protection", "Mode"] }]);
  });

  // The legacy scope key is accepted with no overlay and kept as stored.
  test("turning off a legacy scope while its overlay is absent is refused without step-up", async () => {
    const withLegacy = { ...BLOCK, scopes: { chatPrompts: true, uploads: true, microsoftImports: true } };
    const { tenantId, store } = await tenantWith(withLegacy);
    const save = { ...BLOCK, scopes: { chatPrompts: true, uploads: true, microsoftImports: false } };
    await expect(store.setPiiProtection(tenantId, save, classified(false))).rejects.toBeInstanceOf(WeakerChangeError);

    const overlay = new PiiImportScopeRegistry();
    overlay.register({ subjectKind: "microsoft_import", scopeKey: "microsoftImports", defaultOn: true });
    expect(resolvePiiPolicy((await stored(tenantId)).pii_protection, overlay).settings.scopes.microsoftImports).toBe(true);
  });
});
