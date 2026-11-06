// An admin repairs a stored PII policy from the Settings form. The form sends
// back the settings that GET /tenant shows, unchanged, with their revision.
// This runs the real routes and store, so it also proves the stored row.

import Fastify from "fastify";
import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { describe, expect, onTestFinished, test } from "vitest";

import { registerTenantRoutes } from "../routes/tenant.js";
import { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
import { resolvePiiPolicy } from "../services/pii/pii-policy.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";

const ENCRYPTION_SECRET = "integration-pii-repair-secret-value";

// Stores the policy at revision 2. The admin's routes use the real store.
async function adminWithStoredPolicy(stored: unknown) {
  const admin = await seedTenantGraph();
  await superuserPool().query(
    "INSERT INTO tenant_org_settings (tenant_id, pii_protection, pii_protection_revision) VALUES ($1, $2::jsonb, 2)",
    [admin.tenantId, JSON.stringify(stored)]
  );
  const app = Fastify();
  onTestFinished(() => app.close());
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: admin.userId, tenantId: admin.tenantId, role: "admin", isAdmin: true };
  });
  await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), tenantOrgSettings: new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET) });
  await app.ready();
  const read = async () => {
    const response = await app.inject({ method: "GET", url: "/tenant" });
    expect(response.statusCode).toBe(200);
    return response.json().settings;
  };
  // The form's repair: the shown settings, unchanged, with their revision.
  const saveShown = async () => {
    const shown = await read();
    return app.inject({
      method: "PUT",
      url: "/tenant/settings/pii",
      payload: { ...shown.piiProtection, expectedRevision: shown.piiProtectionRevision }
    });
  };
  const storedRow = async () => (await superuserPool().query<{ pii_protection: unknown }>(
    "SELECT pii_protection FROM tenant_org_settings WHERE tenant_id = $1",
    [admin.tenantId]
  )).rows[0].pii_protection;
  return { read, saveShown, storedRow };
}

describe.skipIf(!adminDatabaseUrl())("PII policy repair from the admin form", () => {
  test("a save of the shown settings repairs a malformed policy and removes its unknown keys", async () => {
    const { read, saveShown, storedRow } = await adminWithStoredPolicy({
      ...DEFAULT_PII_PROTECTION,
      enabled: true,
      mode: "sometimes",
      futureOption: true,
      provider: { type: "openai-compatible", model: "", endpoint: "https://pii.example.test" },
      scopes: { chatPrompts: true, uploads: true, retiredImports: false }
    });

    const before = await read();
    expect(before.piiProtectionHealth).toEqual({ state: "error", reasons: ["mode_invalid"], fields: ["mode"] });

    expect((await saveShown()).statusCode).toBe(200);

    const after = await read();
    expect(after.piiProtectionHealth).toEqual({ state: "ok", reasons: [], fields: [] });
    expect(after.piiProtection).toEqual(before.piiProtection);
    expect(after.piiProtectionRevision).toBe(3);
    const row = await storedRow();
    // The unknown keys are gone. A scope key that no import source registered stays as stored.
    expect(row).toEqual({ ...before.piiProtection, scopes: { chatPrompts: true, uploads: true, retiredImports: false } });
    // The scan no longer stops content in scope.
    expect(resolvePiiPolicy(row, new PiiImportScopeRegistry()).activation).toBe("on");
  });

  test("a save with no change of a policy that is on with mode Off keeps protection on", async () => {
    const { read, saveShown, storedRow } = await adminWithStoredPolicy({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "off" });
    expect((await read()).piiProtectionHealth).toEqual({ state: "error", reasons: ["mode_off_while_enabled"], fields: ["mode"] });

    expect((await saveShown()).statusCode).toBe(200);

    expect((await read()).piiProtectionHealth).toEqual({ state: "ok", reasons: [], fields: [] });
    const row = await storedRow();
    expect(row).toMatchObject({ enabled: true, mode: "block" });
    expect(resolvePiiPolicy(row, new PiiImportScopeRegistry()).activation).toBe("on");
  });
});
