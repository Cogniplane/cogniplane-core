"use client";

import { useCallback, useState } from "react";
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
    busyKey,
    error,
    errorKey,
    successMessage,
    successKey,
    handleSaveProviderKey
  } = useAdminOrganizationData();

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
  const pageError =
    (providerKeyFailed ? null : error) ??
    (catalogQuery.error
      ? toErrorMessage(catalogQuery.error, "Failed to load the model catalog.")
      : null) ??
    (settingsQuery.error
      ? toErrorMessage(settingsQuery.error, "Failed to load tenant settings.")
      : null) ??
    (removeModelMutation.error
      ? toErrorMessage(removeModelMutation.error, "Failed to remove the custom model.")
      : null);

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
      {pageError ? <p className="text-sm text-danger">{pageError}</p> : null}
      {requestedProvider && !targetProvider ? <p role="alert" className="text-sm text-on-surface-variant">This provider is not available. Choose a provider below.</p> : null}
      {!pageError && (!catalogQuery.data || !settingsQuery.data) ? <p role="status" className="text-sm text-on-surface-variant">Loading models...</p> : null}
      <AdminModelAvailabilityCard
        catalog={catalogQuery.data ?? null}
        settings={settingsQuery.data ?? null}
        saving={availabilityMutation.isPending}
        saveError={availabilityMutation.error ? toErrorMessage(availabilityMutation.error, "Failed to save model availability.") : null}
        onSave={async (input) => {
          try {
            await availabilityMutation.mutateAsync(input);
            return true;
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 409)) return false;
            // Another save moved the settings version. Load it so the draft can rebase.
            const reloaded = await settingsQuery.refetch();
            return reloaded.data && reloaded.data.version > input.expectedVersion ? { conflict: reloaded.data } : false;
          }
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
          try {
            await addModelMutation.mutateAsync(input);
            return true;
          } catch {
            return false;
          }
        }}
        onRemoveModel={async (modelId) => {
          try {
            return await removeModelMutation.mutateAsync(modelId);
          } catch {
            return null;
          }
        }}
        providerKeys={{
          targetProvider,
          tenant,
          busyKey,
          providerSuccessMessage,
          providerErrorMessage,
          onSaveProviderKey: handleSaveProviderKey
        }}
      />
    </section>
  );
}
