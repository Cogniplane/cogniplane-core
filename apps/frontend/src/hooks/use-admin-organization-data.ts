"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  deleteTenantMicrosoftConfig,
  getTenantDetails,
  saveTenantMicrosoftConfig,
  updateTenantProviderKey,
  updateTenantPiiProtection
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { ModelProvider, PiiProtectionSettings } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";

// Per-provider save keys are `save-<provider>-key` so they line up with
// providerKeyBusyKey() in admin-organization-card.tsx.
type ProviderMutationKey = `save-${ModelProvider}-key`;
type MutationKey =
  | ProviderMutationKey
  | "microsoft-save"
  | "microsoft-remove"
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
  const [activeMutation, setActiveMutation] = useState<MutationKey | null>(null);

  const tenantQuery = useQuery({
    queryKey: queryKeys.admin.tenant(),
    queryFn: getTenantDetails
  });

  const invalidateTenant = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenant() });

  const run = async <T>(ctx: OrgMutationContext, fn: () => Promise<T>): Promise<T | undefined> => {
    setActiveMutation(ctx.key);
    setMutationError(null);
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
    busyKey: activeMutation,
    error: mutationError ?? tenantLoadError,
    successMessage,
    successKey,
    handleSaveProviderKey: async (provider: ModelProvider, apiKey: string) => {
      const label = MODEL_PROVIDER_META[provider].label;
      // An empty key is the removal path (the backend clears the stored key).
      const removing = apiKey.trim() === "";
      await run(
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
          await invalidateTenant();
          // Key presence feeds the admin model catalog's key-source pills.
          await queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelCatalog() });
        }
      );
    },
    handleSaveMicrosoftConfig: async (config: {
      clientId?: string;
      clientSecret?: string;
      entraTenantId?: string;
    }) => {
      await run(
        {
          key: "microsoft-save",
          successMessage: "Microsoft OAuth configuration saved.",
          errorFallback: "Failed to save Microsoft configuration."
        },
        async () => {
          await saveTenantMicrosoftConfig(config);
          await invalidateTenant();
        }
      );
    },
    handleRemoveMicrosoftConfig: async () => {
      await run(
        {
          key: "microsoft-remove",
          successMessage: "Microsoft OAuth configuration removed.",
          errorFallback: "Failed to remove Microsoft configuration."
        },
        async () => {
          await deleteTenantMicrosoftConfig();
          await invalidateTenant();
        }
      );
    },
    handleSavePiiProtection: async (settings: PiiProtectionSettings) => {
      await run(
        {
          key: "save-pii-protection",
          successMessage: "PII protection settings saved.",
          errorFallback: "Failed to save PII settings."
        },
        async () => {
          await updateTenantPiiProtection(settings);
          await invalidateTenant();
        }
      );
    }
  };
}
