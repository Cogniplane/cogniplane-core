"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  confirmMicrosoftConnection,
  createMicrosoftAuthorizationUrl,
  deleteMicrosoftConnection,
  fetchMicrosoftConnectionStatus
} from "../lib/settings-api";
import { toErrorMessage } from "../../../../apps/frontend/src/lib/error-utils";
import { microsoftQueryKeys } from "../lib/query-keys";

export function useMicrosoftConnection() {
  const queryClient = useQueryClient();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [activeMutation, setActiveMutation] = useState<"connect" | "disconnect" | "confirm" | null>(null);

  const statusQuery = useQuery({
    queryKey: microsoftQueryKeys.settings(),
    queryFn: fetchMicrosoftConnectionStatus
  });

  const disconnectMutation = useMutation({
    mutationFn: deleteMicrosoftConnection,
    onMutate: () => setActiveMutation("disconnect"),
    onSettled: () => setActiveMutation(null),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: microsoftQueryKeys.settings() })
  });

  // Confirms a connection that a security change suspended, for the account
  // in the status that the page shows.
  const confirmMutation = useMutation({
    mutationFn: confirmMicrosoftConnection,
    onMutate: () => setActiveMutation("confirm"),
    onSettled: () => {
      setActiveMutation(null);
      // Also after an error: the account can have changed meanwhile.
      void queryClient.invalidateQueries({ queryKey: microsoftQueryKeys.settings() });
    }
  });

  const loadError = statusQuery.error
    ? toErrorMessage(statusQuery.error, "Failed to load Microsoft connection status.")
    : null;
  const disconnectError = disconnectMutation.error
    ? toErrorMessage(disconnectMutation.error, "Failed to disconnect Microsoft account.")
    : null;
  const confirmError = confirmMutation.error
    ? toErrorMessage(confirmMutation.error, "Failed to confirm the Microsoft connection.")
    : null;

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isFetching,
    statusError: loadError,
    busyKey: activeMutation,
    error: connectError ?? disconnectError ?? confirmError ?? loadError,
    reload: () =>
      queryClient.invalidateQueries({ queryKey: microsoftQueryKeys.settings() }),
    connect: async () => {
      setActiveMutation("connect");
      setConnectError(null);
      try {
        const url = await createMicrosoftAuthorizationUrl();
        window.location.href = url;
      } catch (error) {
        setConnectError(toErrorMessage(error, "Failed to start Microsoft authorization."));
        setActiveMutation(null);
      }
    },
    disconnect: () => disconnectMutation.mutate(),
    confirm: () => {
      const account = statusQuery.data?.userConnection?.microsoftUserId;
      if (!account) return;
      confirmMutation.reset();
      confirmMutation.mutate(account);
    }
  };
}
