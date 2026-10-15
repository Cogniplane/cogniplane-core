import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { registerAdminArtifactRoutes } from "./admin-artifact-routes.js";

const artifactId = "0196f7ca-8d4b-7a70-9f3f-111111111111";

async function buildMintApp(artifactRow: Record<string, unknown> = {}) {
  const pool = new FakePool()
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
  const auditEvents = new InMemoryAuditEventStore();
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
  await registerAdminArtifactRoutes(app, { auditEvents: auditEvents as never });
  return { app, pool, auditEvents };
}

const mintedToken = (pool: FakePool) =>
  pool.queries.some((query) => query.text.includes("INSERT INTO artifact_download_tokens"));

describe("admin artifact download tokens", () => {
  test("records the admin actor and artifact owner when minting a token", async () => {
    const { app, auditEvents } = await buildMintApp();

    const response = await app.inject({
      method: "POST",
      url: `/admin/artifacts/${artifactId}/download-token`,
      headers: { "user-agent": "test-agent" }
    });

    expect(response.statusCode).toBe(200);
    const event = auditEvents.events.find(
      (entry) => entry.type === "admin.artifact.download_token_minted"
    );
    expect(event?.userId).toBe("admin-user");
    expect(event?.payload).toEqual({
      artifactId,
      actorUserId: "admin-user",
      ownerUserId: "owner-user"
    });
    await app.close();
  });

  test.each(["blocked", "pending", "scanning"] as const)(
    "refuses a ready artifact whose PII verdict is %s, without a token or an audit event",
    async (piiStatus) => {
      // The status column says ready; only the PII verdict says otherwise.
      const { app, pool, auditEvents } = await buildMintApp({
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
      expect(
        auditEvents.events.some((entry) => entry.type === "admin.artifact.download_token_minted")
      ).toBe(false);
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
