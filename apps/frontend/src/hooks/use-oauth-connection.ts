"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toErrorMessage } from "../lib/error-utils";

export type OAuthConnectionBusyKey = "connect" | "disconnect" | "confirm";

type OAuthConnectionMessages = {
  load: string;
  connect: string;
  disconnect: string;
  confirm: string;
};

type OAuthConnectionOptions<TStatus> = {
  queryKey: readonly unknown[];
  fetchStatus: () => Promise<TStatus>;
  createAuthorizationUrl: () => Promise<string>;
  deleteConnection: () => Promise<void>;
  /**
   * Confirms a connection that a security change suspended, for the account
   * in `status`, the status that the page shows. Absent for a provider whose
   * account has no attested identity (Jira): there is no confirm.
   */
  confirmConnection?: (status: TStatus) => Promise<unknown>;
  messages: OAuthConnectionMessages;
  /**
   * Reload the status after a failed disconnect too. Set it when the server
   * can remove the connection and still report an error.
   */
  refreshAfterDisconnectError?: boolean;
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: options.queryKey }),
    onError: () => {
      if (options.refreshAfterDisconnectError) void queryClient.invalidateQueries({ queryKey: options.queryKey });
    }
  });

  const confirmMutation = useMutation({
    mutationFn: options.confirmConnection ?? (async () => undefined),
    onMutate: () => setActiveMutation("confirm"),
    onSettled: () => {
      setActiveMutation(null);
      // Also after an error: the account can have changed meanwhile.
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    }
  });

  const loadError = statusQuery.error
    ? toErrorMessage(statusQuery.error, options.messages.load)
    : null;
  const disconnectError = disconnectMutation.error
    ? toErrorMessage(disconnectMutation.error, options.messages.disconnect)
    : null;

  const confirmError = confirmMutation.error
    ? toErrorMessage(confirmMutation.error, options.messages.confirm)
    : null;

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isFetching,
    statusError: loadError,
    busyKey: activeMutation,
    error: connectError ?? disconnectError ?? confirmError ?? loadError,
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
      confirmMutation.reset();
      disconnectMutation.reset();
      disconnectMutation.mutate();
    },
    confirm: () => {
      if (!statusQuery.data || !options.confirmConnection) return;
      setConnectError(null);
      disconnectMutation.reset();
      confirmMutation.reset();
      confirmMutation.mutate(statusQuery.data);
    }
  };
}
