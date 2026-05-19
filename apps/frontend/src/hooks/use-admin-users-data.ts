"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listAdminUsers, setUserBetaTester } from "../lib/admin-api";
import { isRouteNotFoundError, toErrorMessage, toRouteUnavailableMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { AdminUser } from "@cogniplane/shared-types";

export function useAdminUsersData() {
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: queryKeys.admin.users(),
    queryFn: listAdminUsers
  });

  const mutation = useMutation({
    mutationFn: ({ userId, isBetaTester }: { userId: string; isBetaTester: boolean }) =>
      setUserBetaTester(userId, isBetaTester),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    }
  });

  const loadError = usersQuery.error;
  const available = loadError ? !isRouteNotFoundError(loadError, "GET", "/admin/users") : true;
  const users: AdminUser[] = available ? usersQuery.data ?? [] : [];
  const loadErrorMessage = loadError
    ? toRouteUnavailableMessage(loadError, {
        method: "GET",
        pathPrefix: "/admin/users",
        featureName: "User management",
        fallback: "Failed to load users."
      })
    : null;
  const mutationErrorMessage = mutation.error
    ? toErrorMessage(mutation.error, "Failed to update user access.")
    : null;

  const handleSetBetaTester = (userId: string, isBetaTester: boolean) => {
    mutation.mutate({ userId, isBetaTester });
  };

  return {
    users,
    busyKey: mutation.isPending && mutation.variables
      ? `beta-tester-${mutation.variables.userId}`
      : null,
    error: mutationErrorMessage ?? loadErrorMessage,
    available,
    handleSetBetaTester
  };
}
