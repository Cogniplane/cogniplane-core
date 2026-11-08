// Each PII detail write states the image coverage of its own scan. The
// store merges the detail JSON, so it must remove the coverage of an earlier
// scan: a later complete scan must not keep `imagesNotScanned`, and a later
// failure must not keep `imageScan: "complete"`.
import { describe, expect, test } from "vitest";

import { ArtifactStore } from "../services/artifacts/artifact-store.js";

import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

async function storedPii(artifactId: string): Promise<Record<string, unknown>> {
  const result = await superuserPool().query("SELECT detail_json->'pii' AS pii FROM artifacts WHERE artifact_id = $1", [artifactId]);
  return result.rows[0].pii;
}

describe.skipIf(!adminDatabaseUrl())("artifact PII coverage", () => {
  test("a PII detail write replaces the coverage of an earlier scan and keeps other fields", async () => {
    const fixture = await seedTenantGraph();
    const artifacts = new ArtifactStore(appPool());

    await artifacts.setPiiDetail(fixture.tenantId, fixture.artifactId, {
      status: "scanned", modeApplied: "detect", scanRunId: "scan-1", summaryText: "kept",
      imagesNotScanned: true, imageScan: "partial", imagePagesScanned: 20, imagePageCount: 40
    });
    await artifacts.setPiiDetail(fixture.tenantId, fixture.artifactId, {
      status: "scanned", modeApplied: "detect", scanRunId: "scan-2", imageScan: "complete", imagePagesScanned: 3, imagePageCount: 3
    });
    expect(await storedPii(fixture.artifactId)).toEqual({
      status: "scanned", modeApplied: "detect", scanRunId: "scan-2", summaryText: "kept",
      imageScan: "complete", imagePagesScanned: 3, imagePageCount: 3
    });

    await artifacts.setPiiDetail(fixture.tenantId, fixture.artifactId, { status: "failed", modeApplied: "detect", scanRunId: "scan-3" });
    expect(await storedPii(fixture.artifactId)).toEqual({
      status: "failed", modeApplied: "detect", scanRunId: "scan-3", summaryText: "kept"
    });
  });
});
