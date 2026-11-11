"use client";

import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CustomModelCreateRequest, ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { useAdminOrganizationData } from "../../../hooks/use-admin-organization-data";
import {
  AdminModelAvailabilityCard,
  type ModelAvailabilityInput
} from "../../../components/admin/admin-model-availability-card";
import {
  createCustomModel,
  deleteCustomModel,
  getAdminModelCatalog,
  getOpenRouterModels,
  getTenantSettings,
  updateTenantModelAvailability
} from "../../../lib/admin-api";
import { ApiError } from "../../../lib/api-client";
import { toErrorMessage } from "../../../lib/error-utils";
import { queryKeys } from "../../../lib/query-keys";

export default function AdminModelsPage() {
  const params = useSearchParams();
  const requestedProvider = params.get("provider");
  const targetProvider = MODEL_PROVIDERS.find((provider) => provider === requestedProvider) ?? null;
  const queryClient = useQueryClient();
  const {
    tenant,
    tenantLoading,
    tenantLoadError,
    retryTenantLoad,
    busyKey,
    error,
    errorKey,
    successMessage,
    successKey,
    handleSaveProviderKey
  } = useAdminOrganizationData();

  const writeLock = useRef(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [conflictReadFailed, setConflictReadFailed] = useState(false);
  const beginWrite = (name: string) => {
    if (writeLock.current) return false;
    writeLock.current = true;
    setOperation(name);
    return true;
  };
  const endWrite = () => { writeLock.current = false; setOperation(null); };

  const catalogQuery = useQuery({
    queryKey: queryKeys.models.adminCatalog(),
    queryFn: getAdminModelCatalog
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.tenantSettings(),
    queryFn: getTenantSettings
  });
  const availabilityMutation = useMutation({
    mutationFn: (input: { expectedVersion: number } & Partial<ModelAvailabilityInput>) => updateTenantModelAvailability(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.tenantSettings(), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.models.all });
    }
  });

  // OpenRouter catalog is fetched lazily, only once the add-model form needs it.
  const [openRouterWanted, setOpenRouterWanted] = useState(false);
  const openRouterQuery = useQuery({
    queryKey: queryKeys.admin.openRouterModels(),
    queryFn: getOpenRouterModels,
    enabled: openRouterWanted,
    staleTime: 5 * 60 * 1000
  });
  const handleNeedOpenRouterModels = useCallback(() => setOpenRouterWanted(true), []);

  const invalidateModelData = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.models.all });
  };
  const addModelMutation = useMutation({
    mutationFn: (input: CustomModelCreateRequest) => createCustomModel(input),
    onSuccess: invalidateModelData
  });
  const removeModelMutation = useMutation({
    mutationFn: (modelId: string) => deleteCustomModel(modelId),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.tenantSettings(), updated);
      invalidateModelData();
    }
  });

  // A provider key error shows in that provider's form.
  const providerKeyFailed = MODEL_PROVIDERS.some((provider) => errorKey === `save-${provider}-key`);
  const pageError = (providerKeyFailed || tenantLoadError ? null : error) ??
    (removeModelMutation.error ? toErrorMessage(removeModelMutation.error, "Failed to remove the custom model.") : null);
  const modelReadFailed = catalogQuery.isError || settingsQuery.isError || conflictReadFailed;
  // The card rebases its draft on the settings that this read returns.
  const retrySettings = async () => {
    const result = await settingsQuery.refetch();
    if (result.isError || !result.data) return;
    setConflictReadFailed(false);
  };

  // Route the single success message to the provider form that produced it.
  const providerSuccessMessage = Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => [
      provider,
      successKey === `save-${provider}-key` ? successMessage : null
    ])
  ) as Partial<Record<ModelProvider, string | null>>;
  const providerErrorMessage = Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => [provider, errorKey === `save-${provider}-key` ? error : null])
  ) as Partial<Record<ModelProvider, string | null>>;

  return (
    <section id="models" className="flex flex-col gap-5 pt-5">
      {pageError ? <p role="alert" className="text-sm text-danger">{pageError}</p> : null}
      {catalogQuery.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-danger">{catalogQuery.data ? "The model catalog could not refresh. Earlier models are shown. Changes are paused." : "The model catalog could not load."}</p><button type="button" className="rounded-md border border-input px-3 py-2" disabled={catalogQuery.isFetching} onClick={() => void catalogQuery.refetch()}>Retry model catalog</button></div> : null}
      {settingsQuery.isError || conflictReadFailed ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-danger">{conflictReadFailed ? "Settings changed, but the latest version could not load. Your draft is kept. Retry the read before saving again." : settingsQuery.data ? "Model settings could not refresh. Earlier settings and your draft are kept. Retry before saving." : "Model settings could not load. Retry to start editing."}</p><button type="button" className="rounded-md border border-input px-3 py-2" disabled={settingsQuery.isFetching} onClick={() => void retrySettings()}>Retry model settings</button></div> : null}
      {tenantLoadError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-danger">Organization key status could not {tenant ? "refresh. Earlier status is shown" : "load"}. Key changes are paused.</p><button type="button" className="rounded-md border border-input px-3 py-2" disabled={tenantLoading} onClick={() => void retryTenantLoad()}>Retry key status</button></div> : null}
      {requestedProvider && !targetProvider ? <p role="alert" className="text-sm text-on-surface-variant">This provider is not available. Choose a provider below.</p> : null}
      {!modelReadFailed && (!catalogQuery.data || !settingsQuery.data) ? <p role="status" className="text-sm text-on-surface-variant">Loading models...</p> : null}
      <AdminModelAvailabilityCard
        catalog={catalogQuery.data ?? null}
        settings={settingsQuery.data ?? null}
        saving={availabilityMutation.isPending}
        writesBlocked={modelReadFailed || Boolean(operation && operation !== "availability")}
        readError={modelReadFailed ? "Model changes are paused because the latest data could not load. Your draft is kept." : null}
        retryingRead={catalogQuery.isFetching || settingsQuery.isFetching}
        onRetryRead={async () => {
          if (catalogQuery.isFetching || settingsQuery.isFetching) return;
          await Promise.all([catalogQuery.refetch(), retrySettings()]);
        }}
        saveError={availabilityMutation.error ? toErrorMessage(availabilityMutation.error, "Failed to save model availability.") : null}
        onSave={async (input) => {
          if (modelReadFailed || !beginWrite("availability")) return false;
          try {
            const saved = await availabilityMutation.mutateAsync(input);
            return { saved };
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 409)) return false;
            // Another save moved the settings version. Load it so the card can rebase the draft on it.
            const reloaded = await settingsQuery.refetch();
            if (reloaded.isError || !reloaded.data) { setConflictReadFailed(true); return false; }
            return reloaded.data.version > input.expectedVersion ? { conflict: reloaded.data } : false;
          } finally { endWrite(); }
        }}
        adding={addModelMutation.isPending}
        addError={
          addModelMutation.error
            ? toErrorMessage(addModelMutation.error, "Failed to add the model.")
            : null
        }
        openRouterModels={openRouterQuery.data ?? null}
        openRouterLoadError={
          openRouterQuery.error
            ? toErrorMessage(openRouterQuery.error, "Could not load the OpenRouter catalog.")
            : null
        }
        onNeedOpenRouterModels={handleNeedOpenRouterModels}
        onAddModel={async (input) => {
          if (modelReadFailed || !beginWrite("add")) return false;
          try {
            await addModelMutation.mutateAsync(input);
            return true;
          } catch {
            return false;
          } finally { endWrite(); }
        }}
        onRemoveModel={async (modelId) => {
          if (modelReadFailed || !beginWrite("remove")) return null;
          try {
            return await removeModelMutation.mutateAsync(modelId);
          } catch {
            return null;
          } finally { endWrite(); }
        }}
        providerKeys={{
          targetProvider,
          tenant,
          busyKey,
          providerSuccessMessage,
          providerErrorMessage,
          writesBlocked: Boolean(operation && operation !== "key") || tenantLoading || Boolean(tenantLoadError),
          onSaveProviderKey: async (provider, apiKey) => {
            if (tenantLoading || tenantLoadError || !beginWrite("key")) return false;
            try { return await handleSaveProviderKey(provider, apiKey); }
            finally { endWrite(); }
          }
        }}
      />
    </section>
  );
}
