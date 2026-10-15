"use client";

import { useQuery } from "@tanstack/react-query";
import type { MemoryScope } from "@cogniplane/shared-types";

import { listMemories } from "@/lib/memories-api";

export const memoriesKey = (scope: MemoryScope) =>
  ["settings", "memories", scope.tenantId, scope.userId] as const;

/** A response came back for another account or organization. */
export class MemoriesScopeError extends Error {
  constructor() { super("Your account or organization changed. Reload this page."); }
}

/**
 * The signed-in user's memories. The cache key holds the tenant and the user, and
 * a response for any other account is an error, so one account never shows
 * another's memories.
 */
export function useMemories(scope: MemoryScope | null) {
  return useQuery({
    queryKey: scope ? memoriesKey(scope) : ["settings", "memories", "signed-out"],
    enabled: Boolean(scope),
    // The agent saves memories in the chat, so the page reads the list again each time it opens.
    refetchOnMount: "always",
    queryFn: async () => {
      if (!scope) throw new Error("Sign in to view your memories.");
      const result = await listMemories();
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) {
        throw new MemoriesScopeError();
      }
      return result;
    }
  });
}
