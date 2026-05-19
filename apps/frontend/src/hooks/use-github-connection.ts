"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  createGithubAuthorizationUrl,
  deleteGithubConnection,
  fetchGithubConnectionStatus
} from "../lib/settings-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export function useGithubConnection() {
  const queryClient = useQueryClient();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [activeMutation, setActiveMutation] = useState<"connect" | "disconnect" | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.settings.github(),
    queryFn: fetchGithubConnectionStatus
  });

  const disconnectMutation = useMutation({
    mutationFn: deleteGithubConnection,
    onMutate: () => setActiveMutation("disconnect"),
    onSettled: () => setActiveMutation(null),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.github() })
  });

  const loadError = statusQuery.error
    ? toErrorMessage(statusQuery.error, "Failed to load GitHub connection status.")
    : null;
  const disconnectError = disconnectMutation.error
    ? toErrorMessage(disconnectMutation.error, "Failed to disconnect GitHub.")
    : null;

  return {
    status: statusQuery.data ?? null,
    busyKey: activeMutation,
    error: connectError ?? disconnectError ?? loadError,
    reload: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.github() }),
    connect: async () => {
      setActiveMutation("connect");
      setConnectError(null);
      try {
        const url = await createGithubAuthorizationUrl();
        window.location.href = url;
      } catch (error) {
        setConnectError(toErrorMessage(error, "Failed to start GitHub authorization."));
        setActiveMutation(null);
      }
    },
    disconnect: () => disconnectMutation.mutate()
  };
}
