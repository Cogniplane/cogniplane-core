"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminMcpWidgetDomainChangeRequest } from "@cogniplane/shared-types";

import { changeAdminMcpWidgetDomain, getAdminMcpWidgetDomains } from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

/**
 * The widget domains of one proxy server. Nothing loads until `enabled`, so a
 * closed row costs no request.
 */
export function useAdminMcpWidgetDomains(serverId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.admin.mcpWidgetDomains(serverId);
  const query = useQuery({ queryKey, queryFn: () => getAdminMcpWidgetDomains(serverId), enabled });
  const change = useMutation({
    mutationFn: ({ action, input }: { action: "approve" | "revoke"; input: AdminMcpWidgetDomainChangeRequest }) =>
      changeAdminMcpWidgetDomain(serverId, action, input),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
    // Another administrator may have changed the list. Show what is saved now.
    onError: () => queryClient.invalidateQueries({ queryKey })
  });

  return {
    domains: query.data ?? null,
    loading: query.isLoading,
    loadError: query.error ? toErrorMessage(query.error, "Failed to load widget domains.") : null,
    reload: () => query.refetch(),
    changing: change.isPending,
    changeError: change.error ? toErrorMessage(change.error, "The change could not be saved.") : null,
    // Both reject when the change fails, so a form can keep what the person typed.
    approve: (input: AdminMcpWidgetDomainChangeRequest) => change.mutateAsync({ action: "approve", input }),
    revoke: (input: AdminMcpWidgetDomainChangeRequest) => change.mutateAsync({ action: "revoke", input }),
    clearChangeError: () => change.reset()
  };
}
