import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { DownloadHandleEnvelopeSchema } from "@cogniplane/shared-types";

import { withTenantScope } from "../../lib/db.js";
import { apiError, notFoundError } from "../../lib/http-errors.js";
import { artifactIdParams } from "../../lib/route-schemas.js";
import { parseRequestInput } from "../../lib/route-validation.js";
import { serialize } from "../../lib/serialize-response.js";
import { withAdmin } from "./admin-route-helpers.js";

export async function registerAdminArtifactRoutes(app: FastifyInstance): Promise<void> {
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
            SELECT
              artifact_id, session_id, user_id, artifact_type, artifact_name,
              mime_type, storage_backend, storage_key, status
            FROM artifacts
            WHERE tenant_id = $1 AND artifact_id = $2
            LIMIT 1
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

        // Use the artifact OWNER's user_id, not the admin's. The /downloads/:token
        // resolver joins artifacts on (tenant_id, artifact_id, user_id), so the
        // token must be minted with the owner ID or it returns download_not_found.
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
          expiresAt: new Date(row.expires_at).toISOString()
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
