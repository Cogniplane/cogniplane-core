import { describe, expect, test } from "vitest";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedArtifact, seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("artifact pagination", () => {
  test.each(["created_asc", "created_desc"] as const)("%s preserves microseconds across pages", async (sort) => {
    const tenant = await seedTenantGraph();
    const ids = [tenant.artifactId];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await seedArtifact(tenant.tenantId, tenant.userId, tenant.sessionId));
    }
    for (const [index, artifactId] of ids.entries()) {
      await superuserPool().query(
        "UPDATE artifacts SET created_at = '2026-09-21T12:00:00.123000Z'::timestamptz + ($2::int * interval '1 microsecond') WHERE artifact_id = $1",
        [artifactId, index + 1]
      );
    }
    const store = new ArtifactStore(appPool());
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await store.listForUser(tenant.tenantId, tenant.userId, { sort, limit: 2, cursor });
      seen.push(...result.items.map((item) => item.artifactId));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(sort === "created_asc" ? ids : [...ids].reverse());
  });

  // Repeated names and sizes make the id tie-break carry the order. One item per
  // page puts every group of equal keys across a page boundary, so a seek on
  // the key alone would skip or repeat rows.
  test.each([
    ["name_asc", "artifact_name", "ASC"],
    ["name_desc", "artifact_name", "DESC"],
    ["size_asc", "file_size_bytes", "ASC"],
    ["size_desc", "file_size_bytes", "DESC"]
  ] as const)("%s visits every artifact once, in order, across pages", async (sort, column, direction) => {
    const tenant = await seedTenantGraph();
    const ids = [tenant.artifactId];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await seedArtifact(tenant.tenantId, tenant.userId, tenant.sessionId));
    }
    const shapes = [["b.txt", 10], ["a.txt", 30], ["b.txt", 10], ["c.txt", 20], ["a.txt", 30]] as const;
    for (const [index, artifactId] of ids.entries()) {
      await superuserPool().query(
        "UPDATE artifacts SET artifact_name = $2, file_size_bytes = $3 WHERE artifact_id = $1",
        [artifactId, shapes[index]![0], shapes[index]![1]]
      );
    }
    const expected = await superuserPool().query<{ artifact_id: string }>(
      `SELECT artifact_id FROM artifacts WHERE tenant_id = $1 ORDER BY ${column} ${direction}, id ${direction}`,
      [tenant.tenantId]
    );

    const store = new ArtifactStore(appPool());
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.listForUser(tenant.tenantId, tenant.userId, { sort, limit: 1, cursor });
      seen.push(...result.items.map((item) => item.artifactId));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual(expected.rows.map((row) => row.artifact_id));
  });
});
