import { afterEach, describe, expect, test, vi } from "vitest";

import { AVAILABLE_MODELS } from "../domain/models.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";
import { apiError, requestError } from "../lib/http-errors.js";
import { schedulerRuntimeResolver } from "./build-scheduler-worker.js";
import type { CustomModelRecord } from "./custom-model-store.js";
import type { ProviderCredentials } from "./runtime/provider-credentials.js";
import { resolveRuntimeModel, type RuntimeResolutionInput } from "./runtime/runtime-model-resolver.js";
import { buildDefaultTenantSettingsInput, type TenantSettingsRecord } from "./tenant-settings-store.js";

// The shared resolver has its own tests. Here it is replaced, so these tests
// cover only what the scheduler adds: the inputs it passes and how it maps the
// result for the run ledger.
vi.mock("./runtime/runtime-model-resolver.js", () => ({ resolveRuntimeModel: vi.fn() }));

afterEach(() => { vi.resetAllMocks(); });

const runtimeAdapter = { purgeSessionData: async () => undefined } as unknown as RuntimeAdapter;
const custom: CustomModelRecord = {
  modelId: "custom/kimi", provider: "openrouter", vendorModelId: "moonshotai/kimi", displayName: "Kimi",
  description: "Custom.", contextWindow: 200_000, createdBy: null, createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};

function resolver() {
  const getOrCreateTenantSettings = vi.fn(async (tenantId: string): Promise<TenantSettingsRecord> => ({
    ...buildDefaultTenantSettingsInput(), tenantId, version: 1, configHash: "h", updatedAt: "2026-10-01T00:00:00.000Z"
  }));
  const list = vi.fn(async () => [custom]);
  // Only tenant-b has an OpenAI key, so a wrong tenant or provider answers false.
  const hasKey = vi.fn(async (tenantId: string, provider: string) => tenantId === "tenant-b" && provider === "openai");
  const providerCredentials: ProviderCredentials = {
    hasKey,
    async resolveKey() { throw new Error("the scheduler must not read key values"); },
    platformProviders: new Set()
  };
  const resolve = schedulerRuntimeResolver({
    runtimeAdapter,
    dynamicConfig: { getOrCreateTenantSettings },
    customModels: { list },
    providerCredentials
  });
  return { resolve, getOrCreateTenantSettings, list, hasKey };
}

const lastInput = () => vi.mocked(resolveRuntimeModel).mock.calls.at(-1)![0] as RuntimeResolutionInput;

describe("schedulerRuntimeResolver", () => {
  test("asks for the tenant's default model with that tenant's settings and catalog", async () => {
    vi.mocked(resolveRuntimeModel).mockResolvedValue({ kind: "ok", runtimeAdapter, selectedModel: null, selectedEffort: undefined });
    const { resolve, getOrCreateTenantSettings, list, hasKey } = resolver();

    await resolve("tenant-b");

    const input = lastInput();
    expect(input).toMatchObject({ tenantId: "tenant-b", requestedModel: undefined, requestedEffort: undefined, runtimeAdapter });
    // The key check goes to the tenant's credentials, unchanged.
    expect(await input.stores.hasProviderKey!("tenant-b", "openai")).toBe(true);
    expect(hasKey).toHaveBeenLastCalledWith("tenant-b", "openai");
    expect(await input.stores.hasProviderKey!("tenant-b", "anthropic")).toBe(false);

    expect(await input.stores.getModelAvailability!("tenant-b")).toMatchObject({ tenantId: "tenant-b" });
    expect(getOrCreateTenantSettings).toHaveBeenCalledWith("tenant-b");
    const models = await input.stores.listModels!("tenant-b");
    expect(list).toHaveBeenCalledWith("tenant-b");
    // Built-in models first, then the tenant's custom ones.
    expect(models.map((model) => model.id)).toEqual([...AVAILABLE_MODELS.map((model) => model.id), "custom/kimi"]);
  });

  test("returns the adapter, the selected model, and its effort", async () => {
    const model = AVAILABLE_MODELS[0]!;
    vi.mocked(resolveRuntimeModel).mockResolvedValue({ kind: "ok", runtimeAdapter, selectedModel: model, selectedEffort: "high" });

    expect(await resolver().resolve("tenant-a")).toEqual({ kind: "ok", adapter: runtimeAdapter, modelId: model.id, effort: "high" });
  });

  test("returns no model id when the resolver selected none", async () => {
    vi.mocked(resolveRuntimeModel).mockResolvedValue({ kind: "ok", runtimeAdapter, selectedModel: null, selectedEffort: undefined });

    expect(await resolver().resolve("tenant-a")).toMatchObject({ kind: "ok", modelId: null });
  });

  test.each([
    ["the error message", apiError("runtime_provider_unavailable", "Could not resolve the runtime."), "Could not resolve the runtime."],
    ["every validation detail", requestError([{ path: "model", message: "First." }, { path: "effort", message: "Second." }]), "First.; Second."],
    ["the error code", apiError("no_model_available"), "no_model_available"],
    // A message wins over the details when both are present.
    ["the message ahead of details", { ...requestError([{ path: "model", message: "Detail." }]), message: "Summary." }, "Summary."]
  ])("flattens a resolver error to %s", async (_case, body, message) => {
    vi.mocked(resolveRuntimeModel).mockResolvedValue({ kind: "error", statusCode: 400, body });

    expect(await resolver().resolve("tenant-a")).toEqual({ kind: "error", message });
  });
});
