"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  getRuntimeConfig,
  listRuntimeSessions,
  rolloutRuntimeSessions,
  runRuntimeOpenAiDiagnostic
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { RuntimeOpenAiDiagnostic } from "@cogniplane/shared-types";

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

  const [runtimeDiagnostic, setRuntimeDiagnostic] = useState<RuntimeOpenAiDiagnostic | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  const rolloutMutation = useMutation({
    mutationFn: (mode: "drain_idle" | "refresh_idle") => rolloutRuntimeSessions(mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
    }
  });

  const diagnosticMutation = useMutation({
    mutationFn: runRuntimeOpenAiDiagnostic,
    onSuccess: (result) => {
      setRuntimeDiagnostic(result);
      setDiagnosticError(null);
    },
    onError: (error) => {
      setDiagnosticError(toErrorMessage(error, "Failed to run OpenAI diagnostic."));
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
  } else if (diagnosticMutation.isPending) {
    busyKey = "runtime-diagnostic";
  }

  return {
    runtimeSessions: sessionsQuery.data ?? [],
    runtimeConfig: configQuery.data ?? null,
    runtimeDiagnostic,
    busyKey,
    error: diagnosticError ?? rolloutError ?? sessionsError,
    handleDrainIdle: () => rolloutMutation.mutate("drain_idle"),
    handleRefreshIdle: () => rolloutMutation.mutate("refresh_idle"),
    handleRunDiagnostic: () => {
      setDiagnosticError(null);
      diagnosticMutation.mutate();
    }
  };
}
