"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getTenantSettings, updateTenantAgentSettings } from "../lib/admin-api";
import type { ApprovalPolicy, TenantSettings } from "@cogniplane/shared-types";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export type TenantSettingsInput = {
  enabledRuntimeProviders: Array<"codex" | "claude-code">;
  showEffortSelector: boolean;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: "user" | "guardian_subagent";
  allowCommandExecution: boolean;
  allowUserTokenForwarding: boolean;
  autoApproveReadOnlyTools: boolean;
  developerInstructions: string | null;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
};

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
    save: async (input: TenantSettingsInput): Promise<boolean> => {
      try {
        await saveMutation.mutateAsync(input);
        return true;
      } catch {
        return false;
      }
    },
    reload: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantSettings() })
  };
}
