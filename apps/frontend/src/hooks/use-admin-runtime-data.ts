"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getRuntimeConfig,
  listRuntimeSessions,
  rolloutRuntimeSessions
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export function useAdminRuntimeData() {
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: queryKeys.admin.runtimeSessions(),
    queryFn: listRuntimeSessions
  });
  const configQuery = useQuery({
    queryKey: queryKeys.admin.runtimeConfig(),
    queryFn: getRuntimeConfig,
    // Cheap endpoint, paired with sessions — a config fetch failure is
    // non-fatal so we surface the sessions error instead.
    retry: false
  });

  const rolloutMutation = useMutation({
    mutationFn: (mode: "drain_idle" | "refresh_idle") => rolloutRuntimeSessions(mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
    }
  });

  const sessionsError = sessionsQuery.error
    ? toErrorMessage(sessionsQuery.error, "Failed to load runtime sessions.")
    : null;
  const rolloutError = rolloutMutation.error
    ? toErrorMessage(
        rolloutMutation.error,
        rolloutMutation.variables === "drain_idle"
          ? "Failed to drain runtimes."
          : "Failed to refresh runtimes."
      )
    : null;

  let busyKey: string | null = null;
  if (rolloutMutation.isPending) {
    busyKey = rolloutMutation.variables === "drain_idle" ? "drain" : "refresh";
  }

  return {
    runtimeSessions: sessionsQuery.data ?? [],
    runtimeConfig: configQuery.data ?? null,
    busyKey,
    error: rolloutError ?? sessionsError,
    handleDrainIdle: () => rolloutMutation.mutate("drain_idle"),
    handleRefreshIdle: () => rolloutMutation.mutate("refresh_idle")
  };
}
