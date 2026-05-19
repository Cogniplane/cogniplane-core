import { access } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import {
  AdminRuntimeConfigSchema,
  RuntimeOpenAiDiagnosticSchema,
  RuntimeSessionsListResponseSchema
} from "@cogniplane/shared-types";

import { serialize } from "../../lib/serialize-response.js";
import { summarizeRuntimeConfig } from "../../domain/runtime-manifest.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { RuntimeSessionStore } from "../../services/runtime/runtime-session-store.js";
import type { CodexRuntimeManager } from "../../services/runtime-manager.js";
import { rolloutBodySchema } from "./admin-route-schemas.js";
import {
  createAdminAuditEvent,
  parseAdminBody,
  withAdmin
} from "./admin-route-helpers.js";

/**
 * Extracts the `mode` field from a session's `lifecycleMetadata` JSONB. Only
 * the Claude adapter currently writes this (values: "local" | "e2b"); Codex
 * sessions have no mode distinction, so we return null for them. Returning
 * null (not undefined) lets the UI render a neutral "—" placeholder instead
 * of branching on "field exists."
 */
export function extractLifecycleMode(
  lifecycleMetadata: Record<string, unknown>
): "local" | "e2b" | null {
  const raw = lifecycleMetadata.mode;
  if (raw === "local" || raw === "e2b") return raw;
  return null;
}

export async function registerAdminRuntimeRoutes(
  app: FastifyInstance,
  stores: {
    auditEvents: AuditEventStore;
    runtimeSessions: RuntimeSessionStore;
    runtimeManager: CodexRuntimeManager;
  }
): Promise<void> {
  app.get("/admin/runtime-sessions", withAdmin(app, async (request) => {
    const runtimeSessions = await stores.runtimeSessions.listRecent(request.auth.tenantId, 100);
    return serialize(RuntimeSessionsListResponseSchema, {
      runtimeSessions: runtimeSessions.map((runtimeSession) => ({
        ...runtimeSession,
        configSummary: summarizeRuntimeConfig(runtimeSession.manifestMetadata),
        // `runtimeProvider` already comes through the spread from the store
        // column `runtime_sessions.runtime_provider` — don't override it,
        // that column is authoritative for both Codex and Claude rows.
        // Only surface `mode` from lifecycleMetadata since the store has no
        // typed column for the local-vs-e2b distinction yet.
        mode: extractLifecycleMode(runtimeSession.lifecycleMetadata)
      }))
    });
  }));

  // Surfaces operator-level runtime configuration (env-driven, read-only) so
  // the admin UI can tell at a glance which execution backends are active
  // across the fleet. Intentionally small — add new fields here lazily as
  // the UI needs them.
  app.get("/admin/runtime-config", withAdmin(app, async () => {
    return serialize(AdminRuntimeConfigSchema, {
      // Codex always runs in E2B when RUNTIME_BACKEND=e2b; local otherwise.
      codexBackend: app.config.RUNTIME_BACKEND,
      // Claude uses its own flag since the two providers are independent.
      claudeBackend: app.config.CLAUDE_RUNTIME_BACKEND,
      e2bTemplateId: app.config.E2B_TEMPLATE_ID,
      codexModel: app.config.CODEX_MODEL,
      claudeModel: app.config.CLAUDE_CODE_MODEL,
      anthropicKeyConfigured: Boolean(app.config.ANTHROPIC_API_KEY),
      openaiKeyConfigured: Boolean(app.config.OPENAI_API_KEY)
    });
  }));

  app.get("/admin/runtime/openai-diagnostic", withAdmin(app, async () => {
    const home = os.homedir();
    const codexDir = path.join(home, ".codex");
    const authFile = path.join(codexDir, "auth.json");
    const configFile = path.join(codexDir, "config.toml");

    const model = app.config.CODEX_MODEL;
    const openAiApiKey = app.config.OPENAI_API_KEY;

    const [authFilePresent, configFilePresent, dnsResult, unauthenticatedProbe, authenticatedProbe, responsesNonStreaming, responsesStreaming] =
      await Promise.all([
        fileExists(authFile),
        fileExists(configFile),
        resolveDns(),
        probeOpenAi(),
        openAiApiKey ? probeOpenAi(openAiApiKey) : Promise.resolve({ skipped: true as const }),
        openAiApiKey
          ? probeOpenAiResponses({ apiKey: openAiApiKey, model, stream: false })
          : Promise.resolve({ skipped: true as const }),
        openAiApiKey
          ? probeOpenAiResponses({ apiKey: openAiApiKey, model, stream: true })
          : Promise.resolve({ skipped: true as const })
      ]);

    return serialize(RuntimeOpenAiDiagnosticSchema, {
      checkedAt: new Date().toISOString(),
      home,
      codexAuth: {
        openAiApiKeyPresent: Boolean(openAiApiKey),
        authFilePresent,
        configFilePresent
      },
      dns: dnsResult,
      probes: {
        unauthenticated: unauthenticatedProbe,
        authenticated: authenticatedProbe,
        responsesNonStreaming,
        responsesStreaming
      }
    });
  }));

  app.post("/admin/runtime-sessions/rollout", withAdmin(app, async (request, reply) => {
    const parsed = parseAdminBody(reply, rolloutBodySchema, request.body);
    if (!parsed.ok) {
      return parsed.response;
    }

    const affectedSessionIds = await stores.runtimeManager.refreshIdleRuntimes(
      request.auth.tenantId,
      parsed.value.action
    );
    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.runtime_rollout.executed",
      payload: {
        action: parsed.value.action,
        affectedSessionIds
      },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    return {
      action: parsed.value.action,
      affectedSessionIds
    };
  }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDns(): Promise<
  | { ok: true; addresses: Array<{ address: string; family: number }> }
  | { ok: false; error: string }
> {
  try {
    const addresses = await lookup("api.openai.com", { all: true });
    return {
      ok: true,
      addresses: addresses.map((entry) => ({
        address: entry.address,
        family: entry.family
      }))
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function probeOpenAi(apiKey?: string): Promise<
  | { skipped: true }
  | { ok: true; status: number; statusText: string }
  | { ok: false; error: string }
> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000)
    });

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function probeOpenAiResponses(input: {
  apiKey: string;
  model: string;
  stream: boolean;
}): Promise<
  | { skipped: true }
  | {
      ok: true;
      status: number;
      statusText: string;
      stream: boolean;
      firstChunkBytes: number | null;
      completedStream: boolean | null;
      totalChunkBytes: number | null;
    }
  | { ok: false; stream: boolean; error: string }
> {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        input: "Reply with exactly the word OK.",
        stream: input.stream,
        max_output_tokens: 16
      }),
      signal: AbortSignal.timeout(20_000)
    });

    let firstChunkBytes: number | null = null;
    let completedStream: boolean | null = null;
    let totalChunkBytes: number | null = null;
    if (input.stream && response.body) {
      const reader = response.body.getReader();
      let total = 0;
      let first = true;

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            completedStream = true;
            break;
          }

          const size = chunk.value?.byteLength ?? 0;
          total += size;
          if (first) {
            firstChunkBytes = size;
            first = false;
          }
        }
      } catch (error) {
        return {
          ok: false,
          stream: input.stream,
          error: error instanceof Error ? error.message : String(error)
        };
      } finally {
        totalChunkBytes = total;
        await reader.cancel().catch(() => {});
      }
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      stream: input.stream,
      firstChunkBytes,
      completedStream,
      totalChunkBytes
    };
  } catch (error) {
    return {
      ok: false,
      stream: input.stream,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
