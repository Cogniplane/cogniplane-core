import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { registerAdminArtifactRoutes } from "./admin-artifact-routes.js";

const artifactId = "0196f7ca-8d4b-7a70-9f3f-111111111111";

async function buildMintApp(artifactRow: Record<string, unknown> = {}, options: { failAudit?: boolean } = {}) {
  const pool = new FakePool()
    .onQuery(/INSERT INTO audit_events/, () => {
      if (options.failAudit) throw new Error("audit insert failed");
      return { rows: [], rowCount: 1 };
    })
    .onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 }))
    .onQuery(/FROM artifacts/, () => ({
      rows: [
        {
          artifact_id: artifactId,
          session_id: "session-1",
          user_id: "owner-user",
          artifact_type: "generated",
          artifact_name: "report.txt",
          mime_type: "text/plain",
          storage_backend: "local",
          storage_key: `tenant-A/${artifactId}.txt`,
          status: "ready",
          detail_json: {},
          ...artifactRow
        }
      ],
      rowCount: 1
    }))
    .onQuery(/INSERT INTO artifact_download_tokens/, () => ({
      rows: [{ token: "download-token", expires_at: new Date(Date.now() + 60_000) }],
      rowCount: 1
    }));
  const app = Fastify();
  app.decorate("config", createTestConfig());
  app.decorate("db", pool.asPool());
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "tenant-A",
      role: "admin",
      isAdmin: true
    };
  });
  await registerAdminArtifactRoutes(app);
  return { app, pool };
}

const mintedToken = (pool: FakePool) =>
  pool.queries.some((query) => query.text.includes("INSERT INTO artifact_download_tokens"));

/** The mint events that the route wrote in the token's transaction. */
const mintEvents = (pool: FakePool) => pool.queries
  .filter((query) => query.text.includes("INSERT INTO audit_events") && query.values[4] === "admin.artifact.download_token_minted")
  .map((query) => ({ tenantId: query.values[0], userId: query.values[2], payload: JSON.parse(String(query.values[5])) }));

describe("admin artifact download tokens", () => {
  test("records the admin actor and artifact owner in the token's transaction", async () => {
    const { app, pool } = await buildMintApp();

    const response = await app.inject({
      method: "POST",
      url: `/admin/artifacts/${artifactId}/download-token`,
      headers: { "user-agent": "test-agent" }
    });

    expect(response.statusCode).toBe(200);
    expect(mintEvents(pool)).toEqual([{
      tenantId: "tenant-A",
      userId: "admin-user",
      payload: { artifactId, actorUserId: "admin-user", ownerUserId: "owner-user" }
    }]);
    const texts = pool.queries.map((query) => query.text.trim());
    expect(texts.findIndex((text) => text.includes("INSERT INTO audit_events")))
      .toBeLessThan(texts.indexOf("COMMIT"));
    await app.close();
  });

  test("returns no token when the mint's audit event cannot be written", async () => {
    const { app, pool } = await buildMintApp({}, { failAudit: true });

    const response = await app.inject({ method: "POST", url: `/admin/artifacts/${artifactId}/download-token` });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("download-token");
    expect(pool.queries.map((query) => query.text.trim())).toContain("ROLLBACK");
    await app.close();
  });

  test.each(["blocked", "pending", "scanning"] as const)(
    "refuses a ready artifact whose PII verdict is %s, without a token or an audit event",
    async (piiStatus) => {
      // The status column says ready; only the PII verdict says otherwise.
      const { app, pool } = await buildMintApp({
        status: "ready",
        detail_json: { pii: { status: piiStatus } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/admin/artifacts/${artifactId}/download-token`
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("artifact_not_ready");
      expect(mintedToken(pool)).toBe(false);
      expect(mintEvents(pool)).toEqual([]);
      await app.close();
    }
  );

  test("selects the PII verdict so the eligibility rule can read it", async () => {
    const { app, pool } = await buildMintApp();

    await app.inject({ method: "POST", url: `/admin/artifacts/${artifactId}/download-token` });

    const select = pool.queries.find((query) => query.text.includes("FROM artifacts"));
    expect(select?.text).toContain("a.detail_json");
    await app.close();
  });

  test.each([
    ["a detect-only verdict with findings", { pii: { status: "scanned", modeApplied: "detect", findingsCount: 4 } }],
    ["a transformed verdict", { pii: { status: "transformed" } }],
    ["no verdict", {}]
  ])("still mints a token for a ready artifact with %s", async (_label, detail) => {
    const { app, pool } = await buildMintApp({ detail_json: detail });

    const response = await app.inject({
      method: "POST",
      url: `/admin/artifacts/${artifactId}/download-token`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().download.token).toBe("download-token");
    expect(mintedToken(pool)).toBe(true);
    await app.close();
  });

  test("refuses an artifact that is not ready, whatever its PII verdict", async () => {
    const { app, pool } = await buildMintApp({
      status: "pending",
      detail_json: { pii: { status: "scanned" } }
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/artifacts/${artifactId}/download-token`
    });

    expect(response.statusCode).toBe(409);
    expect(mintedToken(pool)).toBe(false);
    await app.close();
  });
});
