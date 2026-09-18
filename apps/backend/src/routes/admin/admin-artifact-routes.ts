import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { DownloadHandleEnvelopeSchema } from "@cogniplane/shared-types";

import { withTenantScope } from "../../lib/db.js";
import { apiError, notFoundError } from "../../lib/http-errors.js";
import { artifactIdParams } from "../../lib/route-schemas.js";
import { parseRequestInput } from "../../lib/route-validation.js";
import { serialize } from "../../lib/serialize-response.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import { createAdminAuditEvent, withAdmin } from "./admin-route-helpers.js";

export async function registerAdminArtifactRoutes(
  app: FastifyInstance,
  stores: { auditEvents: Pick<AuditEventStore, "create"> }
): Promise<void> {
  app.post(
    "/admin/artifacts/:artifactId/download-token",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseRequestInput(reply, artifactIdParams, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }

      const { artifactId } = paramsResult.value;
      const { tenantId } = request.auth;
      const tokenValue = randomBytes(24).toString("hex");
      const ttlMs = app.config.ARTIFACT_DOWNLOAD_TTL_MS;

      const result = await withTenantScope(app.db, tenantId, async (client) => {
        const artifactRow = await client.query(
          `
            SELECT a.artifact_id, a.session_id, a.user_id, a.artifact_type,
              a.artifact_name, a.mime_type, a.storage_backend, a.storage_key, a.status
            FROM artifacts a
            JOIN sessions s ON s.tenant_id = a.tenant_id AND s.session_id = a.session_id
            WHERE a.tenant_id = $1 AND a.artifact_id = $2 AND s.project_id IS NULL
            LIMIT 1 FOR SHARE OF s
          `,
          [tenantId, artifactId]
        );

        const artifact = artifactRow.rows[0];
        if (!artifact || artifact.status === "deleted") {
          return { kind: "not_found" as const };
        }

        if (artifact.artifact_type !== "upload" && artifact.status !== "ready") {
          return { kind: "not_ready" as const };
        }

        // This endpoint only handles personal artifacts. Project members use
        // the regular endpoint, which binds the token to their own identity.
        // The session lock prevents assignment to a project during minting.
        const insert = await client.query(
          `
            INSERT INTO artifact_download_tokens (
              token, tenant_id, artifact_id, session_id, user_id,
              storage_backend, storage_key, file_name, content_type,
              expires_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              NOW() + ($10::text || ' milliseconds')::interval
            )
            RETURNING token, expires_at
          `,
          [
            tokenValue,
            tenantId,
            artifact.artifact_id,
            artifact.session_id,
            artifact.user_id,
            artifact.storage_backend,
            artifact.storage_key,
            artifact.artifact_name,
            artifact.mime_type,
            String(ttlMs)
          ]
        );

        const row = insert.rows[0];
        return {
          kind: "ok" as const,
          token: String(row.token),
          expiresAt: new Date(row.expires_at).toISOString(),
          ownerUserId: String(artifact.user_id)
        };
      });

      if (result.kind === "not_found") {
        reply.code(404);
        return notFoundError("artifact_not_found");
      }
      if (result.kind === "not_ready") {
        reply.code(409);
        return apiError("artifact_not_ready");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId,
        userId: request.auth.userId,
        type: "admin.artifact.download_token_minted",
        payload: {
          artifactId,
          actorUserId: request.auth.userId,
          ownerUserId: result.ownerUserId
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });

      return serialize(DownloadHandleEnvelopeSchema, {
        download: {
          token: result.token,
          url: `/downloads/${result.token}`,
          expiresAt: result.expiresAt
        }
      });
    })
  );
}
