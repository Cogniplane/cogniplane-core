import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { registerAdminArtifactRoutes } from "./admin-artifact-routes.js";

describe("admin artifact download tokens", () => {
  test("records the admin actor and artifact owner when minting a token", async () => {
    const artifactId = "0196f7ca-8d4b-7a70-9f3f-111111111111";
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
            status: "ready"
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
});
