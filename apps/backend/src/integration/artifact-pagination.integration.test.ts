import { describe, expect, test } from "vitest";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedArtifact, seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("artifact timestamp pagination", () => {
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
});
