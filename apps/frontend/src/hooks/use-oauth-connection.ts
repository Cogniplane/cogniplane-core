"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toErrorMessage } from "../lib/error-utils";

export type OAuthConnectionBusyKey = "connect" | "disconnect";

type OAuthConnectionMessages = {
  load: string;
  connect: string;
  disconnect: string;
};

type OAuthConnectionOptions<TStatus> = {
  queryKey: readonly unknown[];
  fetchStatus: () => Promise<TStatus>;
  createAuthorizationUrl: () => Promise<string>;
  deleteConnection: () => Promise<void>;
  messages: OAuthConnectionMessages;
};

export function useOAuthConnection<TStatus>(options: OAuthConnectionOptions<TStatus>) {
  const queryClient = useQueryClient();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [activeMutation, setActiveMutation] = useState<OAuthConnectionBusyKey | null>(null);

  const statusQuery = useQuery({
    queryKey: options.queryKey,
    queryFn: options.fetchStatus
  });

  const disconnectMutation = useMutation({
    mutationFn: options.deleteConnection,
    onMutate: () => setActiveMutation("disconnect"),
    onSettled: () => setActiveMutation(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: options.queryKey })
  });

  const loadError = statusQuery.error
    ? toErrorMessage(statusQuery.error, options.messages.load)
    : null;
  const disconnectError = disconnectMutation.error
    ? toErrorMessage(disconnectMutation.error, options.messages.disconnect)
    : null;

  return {
    status: statusQuery.data ?? null,
    busyKey: activeMutation,
    error: connectError ?? disconnectError ?? loadError,
    reload: () => queryClient.invalidateQueries({ queryKey: options.queryKey }),
    connect: async () => {
      setActiveMutation("connect");
      setConnectError(null);
      try {
        const url = await options.createAuthorizationUrl();
        window.location.href = url;
      } catch (error) {
        setConnectError(toErrorMessage(error, options.messages.connect));
        setActiveMutation(null);
      }
    },
    disconnect: () => {
      setConnectError(null);
      disconnectMutation.reset();
      disconnectMutation.mutate();
    }
  };
}
