import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../../../../apps/backend/src/lib/rbac.js";
import { adminAuditEvent } from "../../../../apps/backend/src/routes/admin/admin-route-helpers.js";
import type { AuditEventStore } from "../../../../apps/backend/src/services/audit-event-store.js";
import type { OverlayRouteControls } from "../../../../apps/backend/src/overlay-contracts.js";
import type { TenantRuntimeInvalidator } from "../../../../apps/backend/src/services/integrations/contracts.js";
import { parseRequestInput } from "../../../../apps/backend/src/lib/route-validation.js";
import {
  isValidEntraTenantId,
  type MicrosoftConnectionService
} from "../services/microsoft-connection-service.js";

const microsoftConfigSchema = z.object({
  clientId: z.string().optional(),
  // The Entra tenant id is interpolated into login.microsoftonline.com OAuth URLs,
  // so reject anything that is not a directory GUID, a well-known alias, or a
  // verified *.onmicrosoft.com domain (rejects `/`, `?`, `#`, `:`, whitespace).
  clientSecret: z.string().optional(),
  entraTenantId: z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim() === "" || isValidEntraTenantId(value.trim()), {
      message:
        "entraTenantId must be a directory (tenant) GUID, 'common', 'organizations', 'consumers', or a '<name>.onmicrosoft.com' domain"
    })
});

/** The settings of the Microsoft app, in order, with the names that the owner notice uses. */
const FIELD_LABELS = {
  clientId: "Application (client) ID",
  clientSecret: "Client secret",
  entraTenantId: "Directory (tenant) ID"
} as const;

export type MicrosoftTenantRoutesDeps = {
  microsoftConnections: Pick<
    MicrosoftConnectionService,
    "setTenantMicrosoftConfig" | "removeTenantMicrosoftConfig"
  >;
  auditEvents: Pick<AuditEventStore, "create">;
  runtimeInvalidator: TenantRuntimeInvalidator;
  // The Microsoft app receives the members' Microsoft tokens: a data route.
  dataRoutes: OverlayRouteControls["dataRoutes"];
};

export function registerMicrosoftTenantRoutes(
  app: FastifyInstance,
  deps: MicrosoftTenantRoutesDeps
): void {
  app.put("/tenant/settings/microsoft", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, microsoftConfigSchema, request.body);
    if (!parsed.ok) return parsed.response;

    const patch = {
      clientId: parsed.value.clientId?.trim() || undefined,
      clientSecret: parsed.value.clientSecret?.trim() || undefined,
      entraTenantId: parsed.value.entraTenantId?.trim() || undefined
    };

    if (!patch.clientId && !patch.clientSecret && !patch.entraTenantId) {
      return reply.code(400).send({
        error: "at_least_one_field_required",
        fields: ["clientId", "clientSecret", "entraTenantId"]
      });
    }

    if (!(await deps.dataRoutes.requireStepUpForOverlay(request, reply, "integration.overlay_settings"))) return reply;

    // The audit event and the owner notice commit with the change. Neither
    // carries a value: only which fields changed.
    const changedFields = (Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>).filter((key) => patch[key] !== undefined);
    await deps.microsoftConnections.setTenantMicrosoftConfig(tenantId, patch, request.auth.userId, () => ({
      tenantId,
      sessionId: null,
      userId: request.auth.userId,
      type: "tenant.integration.updated",
      payload: {
        integrationId: "microsoft",
        configChanged: true,
        changedFields
      },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      alsoInTransaction: deps.dataRoutes.ownerNotice(request, {
        setting: "integration",
        integrationName: "Microsoft 365",
        fields: changedFields.map((key) => FIELD_LABELS[key])
      })
    }));

    return reply.send({ ok: true });
  });

  app.delete("/tenant/settings/microsoft", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    // The audit event commits with the removal. Removing the configuration
    // turns reads and writes off, so sessions drop the tools now.
    await deps.microsoftConnections.removeTenantMicrosoftConfig(tenantId,
      () => adminAuditEvent(request, "tenant.integration.config_cleared", { integrationId: "microsoft" }));
    await deps.runtimeInvalidator.invalidateTenantRuntimes(tenantId, {
      workspaceResetReason:
        "An administrator removed the Microsoft 365 configuration for this organization. " +
        "The execution workspace was reset so the change takes effect. Recreate any files you still need."
    });

    reply.code(204);
    return null;
  });
}
