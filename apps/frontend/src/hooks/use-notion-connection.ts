"use client";

import {
  confirmNotionConnection,
  createNotionAuthorizationUrl,
  deleteNotionConnection,
  fetchNotionConnectionStatus
} from "../lib/settings-api";
import { queryKeys } from "../lib/query-keys";
import { useOAuthConnection } from "./use-oauth-connection";

export function useNotionConnection() {
  return useOAuthConnection({
    queryKey: queryKeys.settings.notion(),
    fetchStatus: fetchNotionConnectionStatus,
    createAuthorizationUrl: createNotionAuthorizationUrl,
    deleteConnection: deleteNotionConnection,
    confirmConnection: async (status) => {
      const user = status.userConnection;
      if (user) await confirmNotionConnection({ notionUserId: user.notionUserId, notionWorkspaceId: user.notionWorkspaceId });
    },
    messages: {
      load: "Failed to load Notion connection status.",
      connect: "Failed to start Notion authorization.",
      disconnect: "Failed to disconnect Notion account.",
      confirm: "Failed to confirm the Notion connection."
    }
  });
}
