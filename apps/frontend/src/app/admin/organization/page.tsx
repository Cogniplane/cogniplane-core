"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CustomModelCreateRequest, ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { useAdminOrganizationData } from "../../../hooks/use-admin-organization-data";
import { useAuth } from "../../../lib/auth-context";
import { AdminOrganizationCard } from "../../../components/admin/admin-organization-card";
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
import { toErrorMessage } from "../../../lib/error-utils";
import { queryKeys } from "../../../lib/query-keys";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LIST_ITEM, SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminOrganizationPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const {
    tenant,
    busyKey,
    error,
    successMessage,
    successKey,
    handleSaveProviderKey
  } = useAdminOrganizationData();

  const catalogQuery = useQuery({
    queryKey: queryKeys.admin.modelCatalog(),
    queryFn: getAdminModelCatalog
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.tenantSettings(),
    queryFn: getTenantSettings
  });
  const availabilityMutation = useMutation({
    mutationFn: (input: ModelAvailabilityInput) => updateTenantModelAvailability(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.tenantSettings(), updated);
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

  const invalidateModelData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelCatalog() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantSettings() })
    ]);
  };
  const addModelMutation = useMutation({
    mutationFn: (input: CustomModelCreateRequest) => createCustomModel(input),
    onSuccess: invalidateModelData
  });
  const removeModelMutation = useMutation({
    mutationFn: (modelId: string) => deleteCustomModel(modelId),
    onSuccess: invalidateModelData
  });

  const pageError =
    error ??
    (catalogQuery.error
      ? toErrorMessage(catalogQuery.error, "Failed to load the model catalog.")
      : null) ??
    (settingsQuery.error
      ? toErrorMessage(settingsQuery.error, "Failed to load tenant settings.")
      : null) ??
    (availabilityMutation.error
      ? toErrorMessage(availabilityMutation.error, "Failed to save model availability.")
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
  const resolvedTenantName = user?.tenantName ?? tenant?.tenantName ?? "Unknown";
  const resolvedTenantSlug = user?.tenantSlug ?? tenant?.slug ?? "Unknown";

  return (
    <section id="organization" className="flex flex-col gap-5 pt-5">
      <Card>
        <CardHeader>
          <p className={SECTION_LABEL}>Current Workspace</p>
          <h2 className="text-lg font-semibold text-on-surface">{resolvedTenantName}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            Authenticated tenant context for this admin session.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className={LIST_ITEM}>
              <strong className="text-sm font-semibold text-on-surface">tenantName</strong>
              <p className="mt-1 text-xs text-on-surface-faint">{resolvedTenantName}</p>
            </div>
            <div className={LIST_ITEM}>
              <strong className="text-sm font-semibold text-on-surface">tenantSlug</strong>
              <p className="mt-1 text-xs text-on-surface-faint">{resolvedTenantSlug}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      {pageError ? <p className="text-sm text-danger">{pageError}</p> : null}
      <AdminOrganizationCard
        tenant={tenant}
        busyKey={busyKey}
        providerSuccessMessage={providerSuccessMessage}
        providerStatuses={catalogQuery.data?.providers}
        onSaveProviderKey={handleSaveProviderKey}
      />
      <AdminModelAvailabilityCard
        catalog={catalogQuery.data ?? null}
        settings={settingsQuery.data ?? null}
        saving={availabilityMutation.isPending}
        onSave={async (input) => {
          try {
            await availabilityMutation.mutateAsync(input);
            return true;
          } catch {
            return false;
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
            await removeModelMutation.mutateAsync(modelId);
            return true;
          } catch {
            return false;
          }
        }}
      />
    </section>
  );
}
