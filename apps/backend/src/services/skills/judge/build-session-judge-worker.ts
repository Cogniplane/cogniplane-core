import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../../config.js";
import type { ActivationTracker } from "../../activation-tracker.js";
import type { DynamicConfigService } from "../../dynamic-config-service.js";
import type { MessageStore } from "../../message-store.js";
import type { SessionJudgmentStore } from "../../session-judgment-store.js";

import { AnthropicBatchJudgeProvider } from "./anthropic-batch-judge-provider.js";
import { AnthropicSyncJudgeProvider } from "./anthropic-sync-judge-provider.js";
import { OpenAIBatchJudgeProvider } from "./openai-batch-judge-provider.js";
import { OpenAISyncJudgeProvider } from "./openai-sync-judge-provider.js";
import { SessionJudgeWorker } from "./session-judge-worker.js";
import type { SkillJudgeProvider } from "./skill-judge-types.js";

/**
 * Build the Tier 3 LLM judge worker (sync mode for v1, batch arrives later
 * as a sibling provider). Returns null when:
 *   - the platform-level switch is off,
 *   - or no provider can be configured (e.g. Anthropic selected but
 *     ANTHROPIC_API_KEY is unset).
 *
 * The per-tenant gate (`tenant_settings.skill_judge_provider`) is applied
 * inside `SessionJudgmentStore.listSessionsToJudge`, so this factory only
 * decides whether the worker can run at all on this instance.
 */
export function buildSessionJudgeWorker(
  config: AppConfig,
  input: {
    sessionJudgments: SessionJudgmentStore;
    messages: MessageStore;
    dynamicConfig: DynamicConfigService;
    activations: ActivationTracker;
    logger: FastifyBaseLogger;
    /**
     * Per-tenant key resolvers — same shape as the ones threaded into
     * `messages.ts`. The factory prefers the tenant key and falls back to
     * the env-level key only if the tenant has none. The env fallback is
     * being retired but stays here so single-tenant dev environments keep
     * working.
     */
    getTenantAnthropicApiKey: (tenantId: string) => Promise<string | null>;
    getTenantOpenaiApiKey: (tenantId: string) => Promise<string | null>;
  }
): SessionJudgeWorker | null {
  if (!config.SKILL_JUDGE_WORKER_ENABLED) return null;

  const envAnthropicKey = config.ANTHROPIC_API_KEY?.trim() || null;
  const envOpenaiKey = config.OPENAI_API_KEY?.trim() || null;

  const providerFactory = async (eligible: {
    tenantId: string;
    provider: string;
    model: string;
    mode: "sync" | "batch";
  }): Promise<SkillJudgeProvider | null> => {
    if (eligible.provider === "anthropic") {
      const tenantKey = (await input.getTenantAnthropicApiKey(eligible.tenantId))?.trim() || null;
      const apiKey = tenantKey || envAnthropicKey;
      if (!apiKey) {
        throw new Error(
          `Anthropic judge requested but no API key is configured for tenant ${eligible.tenantId}.`
        );
      }
      return eligible.mode === "batch"
        ? new AnthropicBatchJudgeProvider({ apiKey, model: eligible.model })
        : new AnthropicSyncJudgeProvider({ apiKey, model: eligible.model });
    }
    if (eligible.provider === "openai") {
      const tenantKey = (await input.getTenantOpenaiApiKey(eligible.tenantId))?.trim() || null;
      const apiKey = tenantKey || envOpenaiKey;
      if (!apiKey) {
        throw new Error(
          `OpenAI judge requested but no API key is configured for tenant ${eligible.tenantId}.`
        );
      }
      return eligible.mode === "batch"
        ? new OpenAIBatchJudgeProvider({ apiKey, model: eligible.model })
        : new OpenAISyncJudgeProvider({ apiKey, model: eligible.model });
    }
    return null;
  };

  return new SessionJudgeWorker(
    {
      judgments: input.sessionJudgments,
      messages: input.messages,
      dynamicConfig: input.dynamicConfig,
      activations: input.activations,
      providerFactory,
      logger: input.logger
    },
    {
      inactiveBeforeMs: config.SKILL_JUDGE_INACTIVE_BEFORE_MS,
      maxSessionsPerTick: config.SKILL_JUDGE_MAX_SESSIONS_PER_TICK,
      runningTimeoutMs: config.SKILL_JUDGE_RUNNING_TIMEOUT_MS
    }
  );
}
