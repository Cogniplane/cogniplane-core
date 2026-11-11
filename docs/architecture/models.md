# Models

Scope: model providers and keys, model enablement, custom models, adding a model
or provider, and the utility model. Spending limits are in [model
spending](model-spending.md).

## Model providers

- Providers: Anthropic, OpenAI, Google, OpenRouter, Z.AI. `MODEL_PROVIDER_META`
  (`packages/shared-types/src/primitives.ts`) names each provider and its
  platform key variable: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`.
- `provider-credentials.ts` resolves the key for the selected model when the
  session builds its graph: the tenant's stored key for that provider first,
  then the platform variable.
- A replaced key reaches a session only when its graph is rebuilt. Rebuild
  causes: another model, effort or metering state; a capability refresh; a new
  runtime (after idle teardown, on another replica, or after a restart). Tenant
  keys are set in Admin > Models and encrypted with `DATA_ENCRYPTION_SECRET`.
- `/models` lists only models whose provider has a key and that the tenant
  enables (Admin > Models). It is empty when no provider has a key or when an
  admin turned off every provider or model.
- Model enablement: `isModelEnabled` in
  `packages/shared-types/src/model-availability.ts`. An enabled provider with a
  null allowlist allows all its models; an empty allowlist allows none. The
  backend prunes unavailable model ids; an allowlist that pruning empties
  becomes null. Frontend caches refresh through the `queryKeys.models.all`
  prefix (`apps/frontend/src/lib/query-keys.ts`).
- Admin > Models edits these settings as one draft
  (`apps/frontend/src/components/admin/model-availability-draft.ts`). A save
  sends `expectedVersion` and only the settings that the draft changed. When a
  newer version arrives (a refused save, a reload, a custom model removal), the
  draft moves to it: unchanged settings take the newer values, the provider
  and model lists merge item by item, and each model's default effort merges
  separately. When both versions changed the same setting, Save waits until
  the admin keeps or discards the draft's edits.
- Turn checks (`services/runtime/runtime-model-resolver.ts`): a requested model
  must exist and be enabled (400), and its provider must have a key (400
  `provider_api_key_required`).
- A turn without a requested model picks from the enabled models, in order: the
  tenant default model (`defaultModelId`, Admin > Models) if its provider has a
  key, the first built-in provider default with a key, then any enabled model
  with a key, then the catalog default (the key check then refuses it). When no
  model is enabled, the turn gets 400 `no_model_enabled`; interactive and
  scheduled turns use the same resolver.
- `resolveModelConstruction` maps a catalog id to `initChatModel` arguments.
  OpenRouter and Z.AI use the OpenAI client with a custom base URL.
  `applyReasoningEffort` sets reasoning effort per provider. Token usage comes
  from stream `usage_metadata` and is saved on `messages`.

## Custom models

Admins add tenant models in Admin > Models
(`routes/admin/admin-model-routes.ts`, `POST` and `DELETE
/admin/custom-models`). An OpenRouter slug is checked against the public
OpenRouter catalog, which also fills missing metadata; other providers need the
metadata from the admin. Deleting a model prunes it from the tenant's model
settings in the same transaction. Custom models need no code change.

## Add a model or provider

- Built-in model of a supported provider: add it to `AVAILABLE_MODELS`
  (`apps/backend/src/domain/models.ts`) and its rates to `PRICING`
  (`services/token-cost-calculator.ts`). Without rates, it cannot run for a
  tenant with a spending limit.
- New provider: also add it to `MODEL_PROVIDERS` and `MODEL_PROVIDER_META`
  (`packages/shared-types/src/primitives.ts`), its key variable to
  `apps/backend/src/config.ts`, an encrypted key column in `tenant_org_settings`
  (new migration) with its mapping in `services/tenant-org-settings-store.ts`.
  `resolveModelConstruction` reads `initPrefix` and `baseUrl` from the
  `MODEL_PROVIDER_META` entry. An OpenAI-compatible API needs only `initPrefix:
  "openai"` and its `baseUrl` (as OpenRouter and Z.AI). Another API needs its
  LangChain package in `apps/backend/package.json` and its prefix added to the
  `initPrefix` type. Add the provider's effort mapping to `applyReasoningEffort`
  (`deep-agents-graph.ts`). Then update every file that `git grep
  MODEL_PROVIDER_META` lists (admin model and runtime routes, settings schemas,
  frontend provider rows).

## Utility model

`UTILITY_LLM_*` configures an optional operator-run model
(`services/utility-llm-client.ts`, OpenAI or Ollama wire format). Session titles
(`services/session-titler.ts`) use it in this order:

1. The utility model.
2. If it fails or is off: Anthropic, with the tenant's or the platform's key
   (`SESSION_TITLER_*`: model and timeout). This sends the first message to
   Anthropic. A tenant with a spending limit skips this step.
3. With no key: no title.

No switch turns off step 2 for a tenant without a spending limit that has an
Anthropic key.

