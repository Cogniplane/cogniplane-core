"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  getTenantDetails,
  updateTenantProviderKey,
  updateTenantPiiProtection
} from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { ModelProvider, PiiProtectionSettings, TenantDetails } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";

/** The result of a save. `revision` is the revision of the saved settings; a server older than revisions sends none. */
export type PiiSaveResult = { ok: true; revision?: number } | { ok: false };

// Per-provider save keys are `save-<provider>-key` so they line up with
// providerKeyBusyKey() in provider-key-rows.tsx.
type ProviderMutationKey = `save-${ModelProvider}-key`;
type MutationKey =
  | ProviderMutationKey
  | "save-pii-protection";

type OrgMutationContext = {
  key: MutationKey;
  successMessage?: string;
  errorFallback: string;
};

export function useAdminOrganizationData() {
  const queryClient = useQueryClient();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [successKey, setSuccessKey] = useState<MutationKey | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<MutationKey | null>(null);
  const [activeMutation, setActiveMutation] = useState<MutationKey | null>(null);
  // True when the last PII save failed because another session saved first.
  const [piiConflict, setPiiConflict] = useState(false);

  const tenantQuery = useQuery({
    queryKey: queryKeys.admin.tenant(),
    queryFn: getTenantDetails
  });

  const invalidateTenant = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenant() });

  const run = async <T>(ctx: OrgMutationContext, fn: () => Promise<T>): Promise<T | undefined> => {
    setActiveMutation(ctx.key);
    setMutationError(null);
    setErrorKey(null);
    setSuccessMessage(null);
    setSuccessKey(null);
    try {
      const result = await fn();
      if (ctx.successMessage) {
        setSuccessMessage(ctx.successMessage);
        setSuccessKey(ctx.key);
      }
      return result;
    } catch (error) {
      setMutationError(toErrorMessage(error, ctx.errorFallback));
      setErrorKey(ctx.key);
      setSuccessMessage(null);
      setSuccessKey(null);
      return undefined;
    } finally {
      setActiveMutation(null);
    }
  };

  const tenantLoadError = tenantQuery.error
    ? toErrorMessage(tenantQuery.error, "Failed to load organization details.")
    : null;

  return {
    tenant: tenantQuery.data ?? null,
    tenantLoading: tenantQuery.isPending,
    tenantLoadError,
    retryTenantLoad: () => tenantQuery.refetch(),
    mutationError,
    errorKey,
    busyKey: activeMutation,
    error: mutationError ?? tenantLoadError,
    successMessage,
    successKey,
    piiConflict,
    handleSaveProviderKey: async (provider: ModelProvider, apiKey: string) => {
      const label = MODEL_PROVIDER_META[provider].label;
      // An empty key is the removal path (the backend clears the stored key).
      const removing = apiKey.trim() === "";
      return (await run(
        {
          key: `save-${provider}-key`,
          successMessage: removing
            ? `${label} API key removed.`
            : `${label} API key saved.`,
          errorFallback: removing
            ? `Failed to remove ${label} API key.`
            : `Failed to save ${label} API key.`
        },
        async () => {
          await updateTenantProviderKey({ provider, apiKey });
          // Key presence feeds both the admin key-source pills and the chat catalog.
          await Promise.all([
            invalidateTenant(),
            queryClient.invalidateQueries({ queryKey: queryKeys.models.all })
          ]);
          return true;
        }
      )) === true;
    },
    handleSavePiiProtection: async (settings: PiiProtectionSettings, expectedRevision?: number): Promise<PiiSaveResult> => {
      setPiiConflict(false);
      return (await run(
        {
          key: "save-pii-protection",
          successMessage: "PII protection settings saved.",
          errorFallback: "Failed to save PII settings."
        },
        async () => {
          let saved;
          try {
            saved = await updateTenantPiiProtection(settings, expectedRevision);
          } catch (error) {
            if (error instanceof ApiError && error.status === 409 && error.code === "pii_settings_conflict") {
              setPiiConflict(true);
              // Read the current settings. The form keeps the admin's changes
              // until the admin reloads them. The other session's save also
              // changed the policy that the Activity tab shows.
              void invalidateTenant();
              void queryClient.invalidateQueries({ queryKey: queryKeys.admin.piiMetricsAll() });
              throw new Error(
                "These settings changed in another session. Your changes are not saved. Reload to see the current settings.",
                { cause: error }
              );
            }
            throw error;
          }
          // The write response confirms these settings even if the next read fails.
          queryClient.setQueryData<TenantDetails>(queryKeys.admin.tenant(), (current) => {
            if (!current) return current;
            const currentRevision = current.settings.piiProtectionRevision;
            if (currentRevision !== undefined && saved.piiProtectionRevision !== undefined && currentRevision > saved.piiProtectionRevision) return current;
            const settings = { ...current.settings, piiProtection: saved.piiProtection, piiProtectionRevision: saved.piiProtectionRevision };
            // Health from the previous revision no longer describes the saved policy.
            delete settings.piiProtectionHealth;
            return { ...current, settings };
          });
          await invalidateTenant();
          // The Activity tab shows the policy and its health from the metrics.
          void queryClient.invalidateQueries({ queryKey: queryKeys.admin.piiMetricsAll() });
          return { ok: true, revision: saved.piiProtectionRevision } as const;
        }
      )) ?? { ok: false };
    }
  };
}
