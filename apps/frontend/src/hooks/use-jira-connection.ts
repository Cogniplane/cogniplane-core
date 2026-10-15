"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { JiraConnectionSelectRequest, JiraConnectionStatus } from "@cogniplane/shared-types";

import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import {
  createJiraAuthorizationUrl,
  deleteJiraConnection,
  fetchJiraConnectionStatus,
  listJiraAccountCandidates,
  listJiraAccountSites,
  selectJiraConnection
} from "../lib/settings-api";
import { useOAuthConnection } from "./use-oauth-connection";

/**
 * True when the member has something to remove in Pipedream. Settings keep
 * Jira reachable in that case, also after the organization turns Jira off.
 */
export function hasJiraAccountsToManage(status: JiraConnectionStatus | null | undefined): boolean {
  return Boolean(status && (status.userConnection || status.authorizationStarted || status.cleanupPending));
}

export function useJiraConnection() {
  return useOAuthConnection({
    queryKey: queryKeys.settings.jira(),
    fetchStatus: fetchJiraConnectionStatus,
    createAuthorizationUrl: createJiraAuthorizationUrl,
    deleteConnection: deleteJiraConnection,
    // Disconnect removes the local connection before the Pipedream cleanup,
    // so a cleanup error still changes the status.
    refreshAfterDisconnectError: true,
    messages: {
      load: "Failed to load Jira connection status.",
      connect: "Failed to start Jira authorization.",
      disconnect: "Failed to disconnect Jira. Try again."
    }
  });
}

/** Accounts authorized in Pipedream, and the site choice that binds one of them. */
export function useJiraAccountSelection(enabled: boolean) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.settings.jiraAccounts(),
    queryFn: listJiraAccountCandidates,
    enabled
  });
  const select = useMutation({
    mutationFn: (input: JiraConnectionSelectRequest) => selectJiraConnection(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.jira() })
  });
  return {
    accounts: accounts.data ?? [],
    isLoading: accounts.isFetching,
    error: accounts.error
      ? toErrorMessage(accounts.error, "Failed to load your Jira accounts.")
      : select.error
        ? toErrorMessage(select.error, "Failed to save the Jira site.")
        : null,
    reload: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.jiraAccounts() }),
    isSaving: select.isPending,
    loadSites: listJiraAccountSites,
    select: (input: JiraConnectionSelectRequest) => select.mutate(input)
  };
}
