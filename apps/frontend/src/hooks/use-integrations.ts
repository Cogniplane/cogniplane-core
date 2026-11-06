"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteIntegrationConfig, fetchAdminIntegrations, updateIntegration, type UpdateIntegrationInput } from "../lib/integrations-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { AdminIntegrationView } from "@cogniplane/shared-types";

type Operation = "toggle" | "save" | "clear";
type Failure = { operation: Operation; message: string };

export function useAdminIntegrations() {
  const queryClient = useQueryClient();
  const pendingRef = useRef<Record<string, Operation>>({});
  const [pending, setPending] = useState<Record<string, Operation>>({});
  const [errors, setErrors] = useState<Record<string, Failure | undefined>>({});
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((message: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage(message);
    flashTimerRef.current = setTimeout(() => setFlashMessage(null), 1800);
  }, []);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  const listQuery = useQuery({
    queryKey: queryKeys.admin.integrations(),
    queryFn: async () => {
      const fresh = await fetchAdminIntegrations();
      const cached = queryClient.getQueryData<AdminIntegrationView[]>(queryKeys.admin.integrations());
      // A background refresh can finish while a row is still being written.
      return fresh.map(row => pendingRef.current[row.id] ? cached?.find(entry => entry.id === row.id) ?? row : row);
    }
  });
  const replaceRow = (integration: AdminIntegrationView) => {
    queryClient.setQueryData<AdminIntegrationView[]>(queryKeys.admin.integrations(), rows =>
      rows?.map(row => row.id === integration.id ? integration : row));
  };

  const run = async (integrationId: string, operation: Operation, input?: UpdateIntegrationInput): Promise<boolean> => {
    // Claim synchronously, before React renders or the first await yields.
    if (pendingRef.current[integrationId]) return false;
    pendingRef.current = { ...pendingRef.current, [integrationId]: operation };
    setPending(pendingRef.current);
    setErrors(previous => ({ ...previous, [integrationId]: undefined }));
    await queryClient.cancelQueries({ queryKey: queryKeys.admin.integrations() });
    const previous = queryClient.getQueryData<AdminIntegrationView[]>(queryKeys.admin.integrations())?.find(row => row.id === integrationId);
    if (operation === "toggle" && previous && input) {
      replaceRow({ ...previous, readsEnabled: input.readsEnabled ?? previous.readsEnabled, writesEnabled: input.writesEnabled ?? previous.writesEnabled });
    }
    try {
      const saved = operation === "clear" ? await deleteIntegrationConfig(integrationId) : await updateIntegration(integrationId, input!);
      // A background read must not replace this write with an older response.
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.integrations() });
      replaceRow(saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.integrationsAvailability() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() });
      flash(operation === "clear" ? "Configuration cleared." : "Saved.");
      return true;
    } catch (error) {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.integrations() });
      if (operation === "toggle" && previous) replaceRow(previous);
      setErrors(previousErrors => ({ ...previousErrors, [integrationId]: { operation, message: toErrorMessage(error, operation === "clear" ? "Failed to clear integration configuration." : "Failed to update integration.") } }));
      return false;
    } finally {
      const next = { ...pendingRef.current };
      delete next[integrationId];
      pendingRef.current = next;
      setPending(next);
    }
  };

  return {
    integrations: listQuery.data ?? [],
    hasData: listQuery.data !== undefined,
    isLoading: listQuery.isPending,
    isRefreshing: listQuery.isFetching,
    loadError: listQuery.error ? toErrorMessage(listQuery.error, "Failed to load integrations.") : null,
    pending,
    errors,
    flashMessage,
    isPending: (id: string) => Boolean(pendingRef.current[id]),
    reload: () => { if (!Object.keys(pendingRef.current).length) void listQuery.refetch(); },
    update: (id: string, input: UpdateIntegrationInput) => run(id, input.config ? "save" : "toggle", input),
    clearConfig: (id: string) => run(id, "clear")
  };
}
