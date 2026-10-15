"use client";

import { useQuery } from "@tanstack/react-query";

import { listAdminSessions, listAdminUsers } from "../lib/admin-api";
import { queryKeys } from "../lib/query-keys";
import { fetchMemberMonthUsage } from "../lib/token-usage-api";

export const RECENT_SESSION_LIMIT = 6;

/**
 * Data for one person's page. Identity comes from the shared people list, so
 * the directory and the page read one cache entry. Usage and sessions start in
 * parallel with it and are keyed by user ID, so a cached result for another
 * person is never shown.
 */
export function useAdminPersonData(userId: string) {
  const people = useQuery({ queryKey: queryKeys.admin.users(), queryFn: listAdminUsers });
  const usage = useQuery({
    queryKey: queryKeys.admin.memberMonthUsage(userId),
    queryFn: () => fetchMemberMonthUsage(userId)
  });
  const sessionsParams = { userId, limit: RECENT_SESSION_LIMIT };
  const sessions = useQuery({
    queryKey: [...queryKeys.admin.sessions(sessionsParams), "person"],
    queryFn: async () => {
      const page = await listAdminSessions(sessionsParams);
      return { ...page, items: page.items.filter((row) => row.userId === userId) };
    }
  });

  const person = people.data?.find((user) => user.userId === userId) ?? null;
  return { people, person, usage, sessions };
}
