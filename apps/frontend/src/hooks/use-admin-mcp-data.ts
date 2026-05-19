"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAdminMcpServer,
  disableAdminMcpServer,
  listAdminMcpServers,
  publishAdminMcpServer,
  unpublishAdminMcpServer,
  updateAdminMcpServer
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

type SubmitInput = {
  serverId: string;
  serverName: string;
  description: string | null;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  headersAllowlist: string[];
  enabled: boolean;
};

export function useAdminMcpData() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.mcpServers() });

  const serversQuery = useQuery({
    queryKey: queryKeys.admin.mcpServers(),
    queryFn: listAdminMcpServers
  });

  const submitMutation = useMutation({
    mutationFn: async ({ input, editingId }: { input: SubmitInput; editingId: string | null }) => {
      if (editingId) {
        const { serverId, ...payload } = input;
        void serverId;
        await updateAdminMcpServer(editingId, payload);
      } else {
        await createAdminMcpServer(input);
      }
    },
    onSuccess: () => invalidate()
  });

  const publishMutation = useMutation({
    mutationFn: publishAdminMcpServer,
    onSuccess: () => invalidate()
  });

  const unpublishMutation = useMutation({
    mutationFn: unpublishAdminMcpServer,
    onSuccess: () => invalidate()
  });

  const disableMutation = useMutation({
    mutationFn: disableAdminMcpServer,
    onSuccess: () => invalidate()
  });

  let busyKey: string | null = null;
  if (submitMutation.isPending) busyKey = "mcp";
  else if (publishMutation.isPending && publishMutation.variables)
    busyKey = `publish-mcp-${publishMutation.variables}`;
  else if (unpublishMutation.isPending && unpublishMutation.variables)
    busyKey = `unpublish-mcp-${unpublishMutation.variables}`;
  else if (disableMutation.isPending && disableMutation.variables)
    busyKey = `disable-mcp-${disableMutation.variables}`;

  const firstError =
    submitMutation.error ??
    publishMutation.error ??
    unpublishMutation.error ??
    disableMutation.error ??
    serversQuery.error;
  const errorFallback = submitMutation.error
    ? "Failed to save MCP server."
    : publishMutation.error
      ? "Failed to publish MCP server."
      : unpublishMutation.error
        ? "Failed to unpublish MCP server."
        : disableMutation.error
          ? "Failed to disable MCP server."
          : "Failed to load MCP servers.";

  return {
    mcpServers: serversQuery.data ?? [],
    busyKey,
    error: firstError ? toErrorMessage(firstError, errorFallback) : null,
    handleSubmit: async (input: SubmitInput, editingId: string | null): Promise<void> => {
      await submitMutation.mutateAsync({ input, editingId });
    },
    handlePublish: (serverId: string) => publishMutation.mutate(serverId),
    handleUnpublish: (serverId: string) => unpublishMutation.mutate(serverId),
    handleDisable: (serverId: string) => disableMutation.mutate(serverId)
  };
}
