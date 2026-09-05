"use client";

import {
  createGithubAuthorizationUrl,
  deleteGithubConnection,
  fetchGithubConnectionStatus
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
