"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminMcpServer } from "@cogniplane/shared-types";

import { listAdminMcpServers, saveAdminMcpConnection, setInheritedAdminMcpAudience, type McpAudience } from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

type SubmitInput = {
  serverId: string;
  serverName: string;
  description: string | null;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  upstreamAuthType: AdminMcpServer["upstreamAuthType"];
  credentialScope: "organization" | "personal";
  upstreamAuthName: string | null;
  upstreamAuthSecret?: string | null;
  audience: McpAudience;
};

export function useAdminMcpData() {
  const queryClient = useQueryClient();
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.mcpServers() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantSettings() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeConfig() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.runtimeSessions() })
  ]);

  const serversQuery = useQuery({
    queryKey: queryKeys.admin.mcpServers(),
    queryFn: listAdminMcpServers
  });

  const submitMutation = useMutation({
    mutationFn: async ({ input, editingId }: { input: SubmitInput; editingId: string | null }) => {
      await saveAdminMcpConnection(input, editingId);
    },
    // Refresh the effective state after an error too. Another admin may have changed it.
    onSettled: () => invalidate()
  });
  const inheritedMutation = useMutation({
    mutationFn: ({ serverId, audience }: { serverId: string; audience: McpAudience }) =>
      setInheritedAdminMcpAudience(serverId, audience),
    onSettled: () => invalidate()
  });

  let busyKey: string | null = null;
  if (submitMutation.isPending || inheritedMutation.isPending) busyKey = "mcp";

  const saveError = submitMutation.error ?? inheritedMutation.error;

  return {
    mcpServers: serversQuery.data ?? [],
    listGeneration: serversQuery.dataUpdatedAt,
    loading: serversQuery.isPending,
    loaded: serversQuery.data !== undefined,
    reload: () => serversQuery.refetch(),
    busyKey,
    loadError: serversQuery.error ? toErrorMessage(serversQuery.error, "Failed to load MCP connections.") : null,
    saveError: saveError ? toErrorMessage(saveError, "Failed to save MCP availability.") : null,
    // The page shows one save error for both actions, so starting one action
    // clears the other's old error.
    handleSubmit: async (input: SubmitInput, editingId: string | null): Promise<void> => {
      inheritedMutation.reset();
      await submitMutation.mutateAsync({ input, editingId });
    },
    handleSetInheritedAudience: async (serverId: string, audience: McpAudience): Promise<void> => {
      submitMutation.reset();
      await inheritedMutation.mutateAsync({ serverId, audience });
    }
  };
}
