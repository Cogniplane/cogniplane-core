"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../lib/api-client";
import { toErrorMessage } from "../lib/error-utils";
import {
  createGithubAuthorizationUrl,
  deleteGithubConnection,
  fetchGithubConnectionStatus,
  listGithubRepositories,
  updateGithubAllowedRepositories
} from "../lib/settings-api";
import { queryKeys } from "../lib/query-keys";
import { useOAuthConnection } from "./use-oauth-connection";

export function useGithubConnection() {
  return useOAuthConnection({
    queryKey: queryKeys.settings.github(),
    fetchStatus: fetchGithubConnectionStatus,
    createAuthorizationUrl: createGithubAuthorizationUrl,
    deleteConnection: deleteGithubConnection,
    messages: {
      load: "Failed to load GitHub connection status.",
      connect: "Failed to start GitHub authorization.",
      disconnect: "Failed to disconnect GitHub."
    }
  });
}

const ACCOUNT_CHANGED_CODE = "github_account_changed";
export const GITHUB_ACCOUNT_CHANGED_MESSAGE =
  "The connected GitHub account changed. Reload the page, then choose the repositories again.";

/**
 * The repositories that the member can choose from, and the save of the choice.
 * `githubUserId` is the connected account in the status that the page shows,
 * or null when the member is not connected. The listing calls GitHub, so it
 * loads only for a connected account. Its cache key and the save both carry the
 * account, so a listing or a choice made for one account never applies to another.
 */
export function useGithubRepositorySelection(githubUserId: string | null) {
  const queryClient = useQueryClient();
  const listing = useQuery({
    queryKey: queryKeys.settings.githubRepositories(githubUserId ?? ""),
    queryFn: listGithubRepositories,
    enabled: githubUserId !== null,
    // The member refreshes on purpose. A silent refetch would reorder a list they are editing.
    refetchOnWindowFocus: false,
    retry: false
  });
  const save = useMutation({
    mutationFn: (input: { githubUserId: string; repositories: string[] }) =>
      updateGithubAllowedRepositories(input.githubUserId, input.repositories),
    // Exact: the status only. The listing is a GitHub call and stays as it is.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.github(), exact: true }),
    // The server refused the list because another account is connected now.
    // Load the status again, so the page shows the account that is connected.
    onError: (error) => {
      if (error instanceof ApiError && error.code === ACCOUNT_CHANGED_CODE) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.github(), exact: true });
      }
    }
  });
  const accountChanged = save.error instanceof ApiError && save.error.code === ACCOUNT_CHANGED_CODE;
  return {
    repositories: listing.data?.repositories ?? [],
    truncated: listing.data?.truncated ?? false,
    isLoading: listing.isFetching,
    loadError: listing.error ? toErrorMessage(listing.error, "Failed to load your GitHub repositories.") : null,
    reload: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.githubRepositories(githubUserId ?? "") }),
    isSaving: save.isPending,
    saveError: accountChanged
      ? GITHUB_ACCOUNT_CHANGED_MESSAGE
      : save.error
        ? toErrorMessage(save.error, "Failed to save the repositories.")
        : null,
    // A save for another account is not a save for this one.
    saved: save.isSuccess && save.variables?.githubUserId === githubUserId,
    save: (repositories: string[]) => {
      if (githubUserId !== null) save.mutate({ githubUserId, repositories });
    }
  };
}
