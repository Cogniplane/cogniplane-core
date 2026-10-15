"use client";

import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import type { PersonalSkillScope } from "@cogniplane/shared-types";
import { listMySkillSubmissionUpdates } from "@/lib/organization-skill-submissions-api";
import { uniquePageItems } from "@/lib/unique-page-items";

export const skillUpdatesKey = (scope: PersonalSkillScope) =>
  ["settings", "skill-updates", scope.tenantId, scope.userId] as const;

export type SkillUpdatesPage = Awaited<ReturnType<typeof listMySkillSubmissionUpdates>>;
export type SkillUpdatesData = InfiniteData<SkillUpdatesPage, string | undefined>;

/** A page came back for another account or organization. */
export class SkillUpdatesScopeError extends Error {
  constructor() { super("Your account or organization changed. Reload this page."); }
}

/**
 * Loads skill updates one page at a time. A refetch reloads every loaded page
 * in order, so a new update at the top does not hide an older row.
 */
export function useSkillUpdates(scope: PersonalSkillScope | null) {
  return useInfiniteQuery({
    queryKey: scope ? skillUpdatesKey(scope) : ["settings", "skill-updates", "signed-out"],
    enabled: Boolean(scope),
    staleTime: 30_000,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: SkillUpdatesPage) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!scope) throw new Error("Sign in to view skill updates.");
      const result = await listMySkillSubmissionUpdates(pageParam);
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId)
        throw new SkillUpdatesScopeError();
      return result;
    },
    select: (data) => ({
      unreadCount: data.pages[0]?.unreadCount ?? 0,
      updates: uniquePageItems(data.pages.map((page) => ({ items: page.updates })), (item) => item.id),
    }),
  });
}
