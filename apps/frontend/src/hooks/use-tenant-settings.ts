"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getTenantSettings, updateTenantAgentSettings, type TenantAgentSettingsUpdate } from "../lib/admin-api";
import type { TenantSettings } from "@cogniplane/shared-types";
import { ApiError } from "../lib/api-client";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

// The Agent behavior fields of the shared request schema, with the loaded
// version (lib/admin-api.ts).
export type TenantSettingsInput = TenantAgentSettingsUpdate;

export type SaveResult = { ok: true } | { ok: false; status: number | null };

export function useTenantSettings() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.tenantSettings(),
    queryFn: getTenantSettings
  });

  const saveMutation = useMutation({
    mutationFn: updateTenantAgentSettings,
    onSuccess: (updated: TenantSettings) => {
      queryClient.setQueryData(queryKeys.admin.tenantSettings(), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.history() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
      // /models includes showEffortSelector alongside the catalog.
      void queryClient.invalidateQueries({ queryKey: queryKeys.models.all });
    }
  });

  const loadError = settingsQuery.error
    ? toErrorMessage(settingsQuery.error, "Failed to load tenant settings.")
    : null;
  const saveError = saveMutation.error
    ? toErrorMessage(saveMutation.error, "Failed to save tenant settings.")
    : null;

  return {
    settings: settingsQuery.data ?? null,
    saving: saveMutation.isPending,
    error: saveError ?? loadError,
    loadError,
    saveError,
    resetSaveError: () => saveMutation.reset(),
    save: async (input: TenantSettingsInput): Promise<boolean> => {
      try {
        await saveMutation.mutateAsync(input);
        return true;
      } catch {
        return false;
      }
    },
    /**
     * Like save, but a failure carries the HTTP status. 409 means the settings
     * changed first. Other failures can happen after the change was saved.
     */
    saveWithResult: async (input: TenantSettingsInput): Promise<SaveResult> => {
      try {
        await saveMutation.mutateAsync(input);
        return { ok: true };
      } catch (error) {
        return { ok: false, status: error instanceof ApiError ? error.status : null };
      }
    },
    reload: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantSettings() })
  };
}
