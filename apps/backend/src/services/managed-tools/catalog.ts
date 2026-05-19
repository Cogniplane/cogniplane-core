// Managed-tool catalog registry.
//
// Each per-domain module (session-tools, github-tools, notion-tools, ...)
// owns its catalog entries; bootstrap (register-builtin-managed-tools.ts)
// registers them via `catalog.register(entries)`. A private overlay package
// can register additional entries by calling the same method on the shared
// instance — without forking core.
//
// Tools whose authorization is governed by the per-tenant Agent settings
// checklist set `tenantConfigurable: true`. Integration-owned tools
// (GitHub, SharePoint, Notion) are gated by the integrations system and
// must NOT appear in the Agent settings picker — checking one there would
// bypass `tenant_integrations` read/write toggles and readiness checks.

export type ManagedToolCatalogEntry = {
  name: string;
  description: string;
  readOnly: boolean;
  tenantConfigurable: boolean;
};

export class ManagedToolCatalog {
  private readonly entries = new Map<string, ManagedToolCatalogEntry>();

  register(entries: readonly ManagedToolCatalogEntry[]): void {
    for (const entry of entries) {
      if (this.entries.has(entry.name)) {
        throw new Error(`Managed tool already registered: ${entry.name}`);
      }
      this.entries.set(entry.name, entry);
    }
  }

  listIds(): string[] {
    return Array.from(this.entries.keys());
  }

  listReadOnlyIds(): string[] {
    const out: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.readOnly) out.push(entry.name);
    }
    return out;
  }

  get(toolId: string): ManagedToolCatalogEntry | undefined {
    return this.entries.get(toolId);
  }

  listTenantConfigurable(): readonly ManagedToolCatalogEntry[] {
    const out: ManagedToolCatalogEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.tenantConfigurable) out.push(entry);
    }
    return out;
  }
}
