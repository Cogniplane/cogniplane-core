"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteIntegrationConfig,
  fetchAdminIntegrations,
  updateIntegration,
  type UpdateIntegrationInput
} from "../lib/integrations-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { AdminIntegrationView } from "@cogniplane/shared-types";

export function useAdminIntegrations() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  // One handle for the flash timer. Back-to-back saves would otherwise let the
  // first mutation's timer erase the second one's message, and an unmount
  // mid-flash would set state on a gone component.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((message: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage(message);
    flashTimerRef.current = setTimeout(() => setFlashMessage(null), 1800);
  }, []);
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  const listQuery = useQuery({
    queryKey: queryKeys.admin.integrations(),
    queryFn: fetchAdminIntegrations
  });

  const updateMutation = useMutation({
    mutationFn: async (args: { integrationId: string; input: UpdateIntegrationInput }) => {
      return updateIntegration(args.integrationId, args.input);
    },
    onMutate: async ({ integrationId, input }) => {
      setActiveId(integrationId);
      setMutationError(null);
      // A list fetch already in flight would land after this write and clobber
      // the optimistic row; cancel it before taking the snapshot.
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.integrations() });
      // Optimistic update for toggle flips (skip when config is being saved —
      // the response carries the authoritative `hasConfig` / `configSummary`).
      if (input.config) return { previous: null };
      const previous = queryClient.getQueryData<AdminIntegrationView[]>(
        queryKeys.admin.integrations()
      );
      if (previous) {
        queryClient.setQueryData<AdminIntegrationView[]>(
          queryKeys.admin.integrations(),
          previous.map((entry) =>
            entry.id === integrationId
              ? {
                  ...entry,
                  readsEnabled: input.readsEnabled ?? entry.readsEnabled,
                  writesEnabled: input.writesEnabled ?? entry.writesEnabled
                }
              : entry
          )
        );
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      const ctx = context as { previous: AdminIntegrationView[] | null } | undefined;
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.admin.integrations(), ctx.previous);
      }
      setMutationError(toErrorMessage(error, "Failed to update integration."));
    },
    onSuccess: (integration) => {
      const previous = queryClient.getQueryData<AdminIntegrationView[]>(
        queryKeys.admin.integrations()
      );
      if (previous) {
        queryClient.setQueryData<AdminIntegrationView[]>(
          queryKeys.admin.integrations(),
          previous.map((entry) => (entry.id === integration.id ? integration : entry))
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.integrationsAvailability()
      });
      flash("Saved.");
    },
    onSettled: () => {
      setActiveId(null);
    }
  });

  const clearMutation = useMutation({
    mutationFn: (integrationId: string) => deleteIntegrationConfig(integrationId),
    onMutate: (integrationId) => {
      setActiveId(integrationId);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(toErrorMessage(error, "Failed to clear integration configuration."));
    },
    onSuccess: (integration) => {
      const previous = queryClient.getQueryData<AdminIntegrationView[]>(
        queryKeys.admin.integrations()
      );
      if (previous) {
        queryClient.setQueryData<AdminIntegrationView[]>(
          queryKeys.admin.integrations(),
          previous.map((entry) => (entry.id === integration.id ? integration : entry))
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.integrationsAvailability()
      });
      flash("Configuration cleared.");
    },
    onSettled: () => setActiveId(null)
  });

  const loadError = listQuery.error
    ? toErrorMessage(listQuery.error, "Failed to load integrations.")
    : null;

  return {
    integrations: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    activeId,
    error: mutationError ?? loadError,
    flashMessage,
    update: (integrationId: string, input: UpdateIntegrationInput) =>
      updateMutation.mutateAsync({ integrationId, input }),
    clearConfig: (integrationId: string) => clearMutation.mutateAsync(integrationId),
    dismissError: () => setMutationError(null)
  };
}
