"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  deleteTenantMicrosoftConfig,
  getTenantDetails,
  saveTenantMicrosoftConfig,
  updateTenantAnthropicKey,
  updateTenantOpenAiKey,
  updateTenantPiiProtection
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { PiiProtectionSettings } from "@cogniplane/shared-types";

type MutationKey =
  | "save-api-key"
  | "save-anthropic-key"
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
    handleSaveApiKey: async (openaiApiKey: string) => {
      await run(
        { key: "save-api-key", successMessage: "OpenAI API key saved.", errorFallback: "Failed to save API key." },
        async () => {
          await updateTenantOpenAiKey({ openaiApiKey });
          await invalidateTenant();
        }
      );
    },
    handleSaveAnthropicKey: async (anthropicApiKey: string) => {
      await run(
        {
          key: "save-anthropic-key",
          successMessage: "Anthropic API key saved.",
          errorFallback: "Failed to save Anthropic API key."
        },
        async () => {
          await updateTenantAnthropicKey({ anthropicApiKey });
          await invalidateTenant();
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
