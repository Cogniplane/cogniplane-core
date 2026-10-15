import { describe, test, expect } from "vitest";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedTenant } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("tenant settings persistence", () => {
test("TenantSettingsStore.upsert preserves existing values for partial updates", async () => {
  const store = new TenantSettingsStore(appPool());
  const tenantId = await seedTenant();

  await store.upsert(tenantId, {
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

  const updated = await store.upsert(tenantId, {
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

test("TenantSettingsStore.upsert applies smart defaults for a new tenant", async () => {
  const store = new TenantSettingsStore(appPool());
  const tenantId = await seedTenant();

  const created = await store.upsert(tenantId, {
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
  const store = new TenantSettingsStore(appPool());
  const tenantId = await seedTenant();
  const result = await store.get(tenantId);
  expect(result).toBe(null);
});

test("TenantSettingsStore.upsert persists showEffortSelector", async () => {
  const store = new TenantSettingsStore(appPool());
  const tenantId = await seedTenant();

  const created = await store.upsert(tenantId, {
    showEffortSelector: true
  });

  expect(created.showEffortSelector).toBe(true);

  const updated = await store.upsert(tenantId, {
    showEffortSelector: false
  });

  expect(updated.showEffortSelector).toBe(false);
});

test("TenantSettingsStore.upsert persists webSearchMode and preserves it across partial updates", async () => {
  const store = new TenantSettingsStore(appPool());
  const tenantId = await seedTenant();

  const created = await store.upsert(tenantId, {
    webSearchMode: "cached"
  });

  expect(created.webSearchMode).toBe("cached");

  // A partial update that omits webSearchMode keeps the stored value.
  const preserved = await store.upsert(tenantId, {
    showEffortSelector: true
  });

  expect(preserved.webSearchMode).toBe("cached");

  const updated = await store.upsert(tenantId, {
    webSearchMode: "disabled"
  });

  expect(updated.webSearchMode).toBe("disabled");
});

  test("preserves model defaults, efforts, and their hash through a partial save", async () => {
    const tenantId = await seedTenant();
    const store = new TenantSettingsStore(appPool());
    const modelDefaultEfforts = { "openai/gpt-5.6-sol": "high" as const };
    const first = await store.upsert(tenantId, { defaultModelId: "openai/gpt-5.6-sol", modelDefaultEfforts });
    const unchanged = await store.upsert(tenantId, {});
    expect(unchanged.configHash).toBe(first.configHash);
    const updated = await store.upsert(tenantId, { developerInstructions: "Changed instructions" });
    expect(updated.configHash).not.toBe(first.configHash);
    expect(await new TenantSettingsStore(appPool()).get(tenantId)).toMatchObject({
      defaultModelId: "openai/gpt-5.6-sol", modelDefaultEfforts, configHash: updated.configHash
    });
    await store.upsert(tenantId, { defaultModelId: null, modelDefaultEfforts: {} });
    expect(await store.get(tenantId)).toMatchObject({ defaultModelId: null, modelDefaultEfforts: {} });
  });

  // VULN-13: the hosts that agent-run code in the sandbox may reach. These run
  // the real INSERT ... ON CONFLICT, which the unit test's fake cannot prove.
  test("approves no sandbox host until a tenant does, and saves the list sorted without duplicates", async () => {
    const tenantId = await seedTenant();
    const store = new TenantSettingsStore(appPool());

    const created = await store.upsert(tenantId, {});
    expect(created.approvedSandboxEgressDomains).toEqual([]);

    const approved = await store.upsert(tenantId, {
      approvedSandboxEgressDomains: ["pypi.org", "*.example.com", "pypi.org", "files.pythonhosted.org"]
    });
    expect(approved.approvedSandboxEgressDomains).toEqual(["*.example.com", "files.pythonhosted.org", "pypi.org"]);
    expect(approved.configHash).not.toBe(created.configHash);
    expect((await store.get(tenantId))!.approvedSandboxEgressDomains).toEqual(["*.example.com", "files.pythonhosted.org", "pypi.org"]);
  });

  test("keeps the approved sandbox hosts through a partial save, and clears them with an empty list", async () => {
    const tenantId = await seedTenant();
    const store = new TenantSettingsStore(appPool());
    await store.upsert(tenantId, { approvedSandboxEgressDomains: ["pypi.org"] });

    const partial = await store.upsert(tenantId, { developerInstructions: "Changed instructions" });
    expect(partial.approvedSandboxEgressDomains).toEqual(["pypi.org"]);

    const cleared = await store.upsert(tenantId, { approvedSandboxEgressDomains: [] });
    expect(cleared.approvedSandboxEgressDomains).toEqual([]);
    expect((await store.get(tenantId))!.approvedSandboxEgressDomains).toEqual([]);
  });

  test("two lists with the same hosts in another order are the same settings", async () => {
    const store = new TenantSettingsStore(appPool());
    const first = await store.upsert(await seedTenant(), { approvedSandboxEgressDomains: ["b.example.com", "a.example.com"] });
    const second = await store.upsert(await seedTenant(), { approvedSandboxEgressDomains: ["a.example.com", "b.example.com"] });
    // The hash covers the tenant id, so compare the stored lists, and the hash of one tenant across a re-save.
    expect(first.approvedSandboxEgressDomains).toEqual(second.approvedSandboxEgressDomains);
    const resaved = await store.upsert(first.tenantId, { approvedSandboxEgressDomains: ["a.example.com", "b.example.com"] });
    expect(resaved.configHash).toBe(first.configHash);
  });

});
