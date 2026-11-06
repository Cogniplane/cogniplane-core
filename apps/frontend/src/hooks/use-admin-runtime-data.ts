"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuntimeRolloutAction } from "@cogniplane/shared-types";

import { getRuntimeConfig, listRuntimeSessions, rolloutRuntimeSessions } from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export function useAdminRuntimeData() {
  const queryClient = useQueryClient();
  const rolloutInFlight = useRef(false);
  const sessionsQuery = useQuery({ queryKey: queryKeys.admin.runtimeSessions(), queryFn: listRuntimeSessions });
  const configQuery = useQuery({ queryKey: queryKeys.admin.runtimeConfig(), queryFn: getRuntimeConfig, retry: false });
  const rolloutMutation = useMutation({
    mutationFn: rolloutRuntimeSessions,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
    }
  });

  const runRollout = (mode: RuntimeRolloutAction) => {
    // The ref guards repeated activation before React publishes the pending state.
    if (rolloutInFlight.current) return;
    rolloutInFlight.current = true;
    rolloutMutation.mutate(mode, { onSettled: () => { rolloutInFlight.current = false; } });
  };

  return {
    runtimeSessions: sessionsQuery.data ?? [],
    sessionsLoaded: sessionsQuery.data !== undefined,
    sessionsLoading: sessionsQuery.isPending,
    sessionsRefreshing: sessionsQuery.isFetching,
    sessionsError: sessionsQuery.error ? toErrorMessage(sessionsQuery.error, "Runtime records could not be loaded.") : null,
    runtimeConfig: configQuery.data ?? null,
    configLoading: configQuery.isPending,
    configRefreshing: configQuery.isFetching,
    configError: configQuery.error ? toErrorMessage(configQuery.error, "Backend configuration could not be loaded.") : null,
    busyKey: rolloutMutation.isPending ? rolloutMutation.variables === "drain_idle" ? "drain" : "refresh" : null,
    rolloutResult: rolloutMutation.data ?? null,
    rolloutError: rolloutMutation.error ? toErrorMessage(rolloutMutation.error, "Idle workspaces could not be reset. Try again.") : null,
    onRetrySessions: () => { void sessionsQuery.refetch({ cancelRefetch: false }); },
    onRetryConfig: () => { void configQuery.refetch({ cancelRefetch: false }); },
    onPrepareRollout: () => { if (!rolloutInFlight.current) rolloutMutation.reset(); },
    onDrainIdle: () => runRollout("drain_idle"),
    onRefreshIdle: () => runRollout("refresh_idle")
  };
}
