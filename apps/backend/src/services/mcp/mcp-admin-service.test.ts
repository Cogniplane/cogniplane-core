import { expect, test } from "vitest";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { McpAdminService } from "./mcp-admin-service.js";

type Stores = ConstructorParameters<typeof McpAdminService>[1];

function makeService(overrides: { mcpServers?: Partial<Stores["mcpServers"]>; tenantSettings?: Partial<Stores["tenantSettings"]> } = {}) {
  return new McpAdminService(createTestConfig(), {
    mcpServers: {
      async listMcpServers() { return []; },
      async getAdminMcpServer() { return null; },
      async createMcpServer() { throw new Error("createMcpServer should not be called"); },
      async updateMcpServer() { throw new Error("updateMcpServer should not be called"); },
      async disableMcpServer() { return null; },
      async setMcpServerPublished() { return null; },
      async withTransaction(_tenantId, run) { return run({} as Parameters<typeof run>[0]); },
      ...overrides.mcpServers
    },
    tenantSettings: {
      async get() { return null; },
      async upsert() { throw new Error("upsert should not be called"); },
      async setMcpServerAllowed() { throw new Error("setMcpServerAllowed should not be called"); },
      ...overrides.tenantSettings
    }
  });
}

test("blocks disabling default MCP servers before tenant settings exist", async () => {
  let disableCalls = 0;
  const service = makeService({
    mcpServers: {
      async disableMcpServer() {
        disableCalls += 1;
        return null;
      }
    }
  });

  await expect(() => service.disableMcpServer("tenant-1", "managed-session-context")).rejects.toThrow(/referenced by the tenant's active settings/);
  expect(disableCalls).toBe(0);
});

test("lists disabled servers too, and reads the allowlist of a tenant with no settings row from a new row", async () => {
  const listed: unknown[][] = [];
  const upserts: unknown[][] = [];
  const service = makeService({
    mcpServers: {
      async listMcpServers(...args) { listed.push(args); return []; }
    },
    tenantSettings: {
      async upsert(...args) {
        upserts.push(args);
        return { enabledMcpServerIds: ["managed-session-context"] } as Awaited<ReturnType<Stores["tenantSettings"]["upsert"]>>;
      }
    }
  });

  await service.listMcpServers("tenant-1");
  expect(listed).toEqual([["tenant-1", true]]);
  await expect(service.listAllowedMcpServerIds("tenant-1")).resolves.toEqual(["managed-session-context"]);
  expect(upserts).toEqual([["tenant-1", {}]]);
});
