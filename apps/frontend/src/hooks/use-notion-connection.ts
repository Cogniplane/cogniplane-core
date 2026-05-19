"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  createNotionAuthorizationUrl,
  deleteNotionConnection,
  fetchNotionConnectionStatus
} from "../lib/settings-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export function useNotionConnection() {
  const queryClient = useQueryClient();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [activeMutation, setActiveMutation] = useState<"connect" | "disconnect" | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.settings.notion(),
    queryFn: fetchNotionConnectionStatus
  });

  const disconnectMutation = useMutation({
    mutationFn: deleteNotionConnection,
    onMutate: () => setActiveMutation("disconnect"),
    onSettled: () => setActiveMutation(null),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.notion() })
  });

  const loadError = statusQuery.error
    ? toErrorMessage(statusQuery.error, "Failed to load Notion connection status.")
    : null;
  const disconnectError = disconnectMutation.error
    ? toErrorMessage(disconnectMutation.error, "Failed to disconnect Notion account.")
    : null;

  return {
    status: statusQuery.data ?? null,
    busyKey: activeMutation,
    error: connectError ?? disconnectError ?? loadError,
    reload: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.notion() }),
    connect: async () => {
      setActiveMutation("connect");
      setConnectError(null);
      try {
        const url = await createNotionAuthorizationUrl();
        window.location.href = url;
      } catch (error) {
        setConnectError(toErrorMessage(error, "Failed to start Notion authorization."));
        setActiveMutation(null);
      }
    },
    disconnect: () => disconnectMutation.mutate()
  };
}
