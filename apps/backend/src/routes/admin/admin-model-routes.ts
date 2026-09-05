import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AdminModelCatalogResponseSchema,
  CustomModelCreateRequestSchema,
  CustomModelEnvelopeSchema,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_META,
  OpenRouterModelsResponseSchema,
  TenantOkResponseSchema
} from "@cogniplane/shared-types";
import type { ModelProvider } from "@cogniplane/shared-types";

import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { CustomModelStore } from "../../services/custom-model-store.js";
import { customModelId, toAvailableModel } from "../../services/custom-model-store.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import type { OpenRouterCatalogFetcher } from "../../services/openrouter-catalog.js";
import { createAdminAuditEvent, withAdmin } from "./admin-route-helpers.js";

export type ModelAdminRouteStores = {
  customModels: Pick<CustomModelStore, "list" | "create" | "delete">;
  dynamicConfig: Pick<DynamicConfigService, "getOrCreateTenantSettings" | "updateTenantSettings">;
  auditEvents: Pick<AuditEventStore, "create">;
  /** See admin-tenant-settings-routes: tenant/platform/none per provider. */
  providerKeySources: (
    tenantId: string
  ) => Promise<Record<ModelProvider, "tenant" | "platform" | "none">>;
  /** Cached public OpenRouter catalog (slug validation + picker). */
  fetchOpenRouterCatalog: OpenRouterCatalogFetcher;
};

// Vendor model ids are path-like slugs ("moonshotai/kimi-k3", "gpt-6-mini",
// "tencent/hy3:free"). Reject anything that could smuggle traversal or
// whitespace into downstream ids; inner single slashes are legitimate.
const VENDOR_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*(\/[a-z0-9][a-z0-9._:-]*)*$/i;

const deleteQuerySchema = z.object({
  modelId: z.string().trim().min(1).max(200)
});

export async function registerAdminModelRoutes(
  app: FastifyInstance,
  stores: ModelAdminRouteStores
): Promise<void> {
  // The FULL model catalog (built-ins + this tenant's custom models) with
  // per-provider key sources — deliberately unfiltered (unlike GET /models)
  // so admins configure availability against everything the platform ships,
  // and see why a provider is or isn't usable.
  app.get("/admin/models", withAdmin(app, async (request, _reply) => {
    const [keySources, customs] = await Promise.all([
      stores.providerKeySources(request.auth.tenantId),
      stores.customModels.list(request.auth.tenantId)
    ]);
    return serialize(AdminModelCatalogResponseSchema, {
      models: [
        ...AVAILABLE_MODELS.map((model) => ({ ...model, source: "builtin" as const })),
        ...customs.map((record) => ({ ...toAvailableModel(record), source: "custom" as const }))
      ],
      providers: MODEL_PROVIDERS.map((provider) => ({
        id: provider,
        label: MODEL_PROVIDER_META[provider].label,
        keySource: keySources[provider] ?? "none"
      }))
    });
  }));

  // Slim OpenRouter catalog for the admin "add model" picker. Server-proxied
  // against the fixed public URL; the browser never calls OpenRouter.
  app.get("/admin/openrouter-models", withAdmin(app, async (_request, reply) => {
    try {
      const entries = await stores.fetchOpenRouterCatalog();
      return serialize(OpenRouterModelsResponseSchema, {
        models: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          contextLength: entry.contextLength
        }))
      });
    } catch (error) {
      app.log.warn({ err: error }, "openrouter catalog fetch failed");
      return reply.status(503).send(
        apiError(
          "openrouter_catalog_unavailable",
          "Could not reach the OpenRouter model catalog. Try again shortly."
        )
      );
    }
  }));

  app.post("/admin/custom-models", withAdmin(app, async (request, reply) => {
    const parsed = CustomModelCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "validation_error",
        message: parsed.error.issues.map((issue) => issue.message).join(", ")
      });
    }
    const input = parsed.data;

    if (!VENDOR_MODEL_ID_PATTERN.test(input.vendorModelId) || input.vendorModelId.includes("..")) {
      return reply.status(400).send(
        apiError("invalid_vendor_model_id", "The vendor model id contains unsupported characters.")
      );
    }

    const modelId = customModelId(input.provider, input.vendorModelId);
    if (AVAILABLE_MODELS.some((model) => model.id === modelId)) {
      return reply.status(409).send(
        apiError("model_already_in_catalog", `"${modelId}" is already a built-in catalog model.`)
      );
    }

    let displayName = input.displayName;
    let description = input.description ?? "";
    let contextWindow = input.contextWindow;

    if (input.provider === "openrouter") {
      // Validate the slug against the public catalog and auto-fill anything
      // the admin omitted. A typo'd slug fails here instead of at first use.
      let entries;
      try {
        entries = await stores.fetchOpenRouterCatalog();
      } catch (error) {
        app.log.warn({ err: error }, "openrouter catalog fetch failed during custom-model create");
        return reply.status(503).send(
          apiError(
            "openrouter_catalog_unavailable",
            "Could not reach the OpenRouter model catalog to validate the slug. Try again shortly."
          )
        );
      }
      const entry = entries.find((candidate) => candidate.id === input.vendorModelId);
      if (!entry) {
        return reply.status(400).send(
          apiError(
            "unknown_openrouter_model",
            `"${input.vendorModelId}" is not a model on OpenRouter. Check the slug on openrouter.ai/models.`
          )
        );
      }
      displayName ??= `${entry.name} (OpenRouter)`;
      contextWindow ??= entry.contextLength ?? 128_000;
      description = description || "Custom OpenRouter model added by an admin.";
    } else {
      // No key-free lookup exists for the other providers; the admin must
      // supply the display metadata themselves.
      if (!displayName || !contextWindow) {
        return reply.status(400).send(
          apiError(
            "missing_model_metadata",
            "displayName and contextWindow are required for non-OpenRouter custom models."
          )
        );
      }
      description = description || `Custom ${MODEL_PROVIDER_META[input.provider].label} model added by an admin.`;
    }

    const record = await stores.customModels.create(request.auth.tenantId, {
      provider: input.provider,
      vendorModelId: input.vendorModelId,
      displayName,
      description,
      contextWindow,
      createdBy: request.auth.userId
    });
    if (!record) {
      return reply.status(409).send(
        apiError("custom_model_exists", `"${modelId}" has already been added.`)
      );
    }

    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.custom_model.created",
      payload: {
        modelId: record.modelId,
        provider: record.provider,
        displayName: record.displayName,
        contextWindow: record.contextWindow
      },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    return serialize(CustomModelEnvelopeSchema, {
      model: { ...toAvailableModel(record), source: "custom" as const }
    });
  }));

  // Model ids contain slashes, so the id travels as a query parameter rather
  // than a path segment.
  app.delete("/admin/custom-models", withAdmin(app, async (request, reply) => {
    const parsed = deleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "validation_error",
        message: parsed.error.issues.map((issue) => issue.message).join(", ")
      });
    }
    const { modelId } = parsed.data;
    const tenantId = request.auth.tenantId;

    const deleted = await stores.customModels.delete(tenantId, modelId);
    if (!deleted) {
      return reply.status(404).send(apiError("custom_model_not_found"));
    }

    // Scrub availability references so the settings row doesn't accumulate
    // stale entries (harmless at runtime, but confusing in the admin UI).
    const settings = await stores.dynamicConfig.getOrCreateTenantSettings(tenantId);
    const referencedInAllowlist = settings.enabledModelIds?.includes(modelId) ?? false;
    const referencedInEfforts = Object.hasOwn(settings.modelDefaultEfforts, modelId);
    if (referencedInAllowlist || referencedInEfforts) {
      const { [modelId]: _removed, ...remainingEfforts } = settings.modelDefaultEfforts;
      await stores.dynamicConfig.updateTenantSettings(tenantId, {
        ...(referencedInAllowlist
          ? { enabledModelIds: settings.enabledModelIds!.filter((id) => id !== modelId) }
          : {}),
        ...(referencedInEfforts ? { modelDefaultEfforts: remainingEfforts } : {})
      });
    }

    await createAdminAuditEvent(stores.auditEvents, {
      tenantId,
      userId: request.auth.userId,
      type: "admin.custom_model.deleted",
      payload: { modelId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    return serialize(TenantOkResponseSchema, { ok: true });
  }));
}
