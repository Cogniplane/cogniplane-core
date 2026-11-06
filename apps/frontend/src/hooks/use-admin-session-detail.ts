"use client";

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { getAdminSessionDetail } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import {
  isRouteNotFoundError,
  toErrorMessage,
  toRouteUnavailableMessage
} from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";

// Match the error code, not the message: the backend may add a readable
// message to this 404 later.
function isSessionNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "session_not_found";
}

export function useAdminSessionDetailData(sessionId: string | null) {
  const query = useQuery<AdminSessionDetailResponse>({
    queryKey: queryKeys.admin.sessionDetail(sessionId ?? ""),
    queryFn: () => {
      if (!sessionId) throw new Error("missing_session_id");
      return getAdminSessionDetail(sessionId);
    },
    enabled: Boolean(sessionId),
    retry: (failureCount, error) => {
      if (isSessionNotFound(error)) return false;
      return failureCount < 2;
    }
  });

  const [retryFailure, setRetryFailure] = useState<{ scope: string | null; error: unknown } | null>(null);
  const scope = sessionId;
  const error = query.error ?? (query.isFetching && retryFailure?.scope === scope ? retryFailure.error : null);
  const isNotFound = isSessionNotFound(error);
  const featureUnavailable =
    error && isRouteNotFoundError(error, "GET", "/admin/sessions");
  const available = !featureUnavailable;

  let errorMessage: string | null = null;
  if (error && !isNotFound) {
    errorMessage = featureUnavailable
      ? toRouteUnavailableMessage(error, {
          method: "GET",
          pathPrefix: "/admin/sessions",
          featureName: "Session review",
          fallback: "Failed to load session detail."
        })
      : toErrorMessage(error, "Failed to load session detail.");
  }

  return {
    detail: available && !isNotFound ? query.data ?? null : null,
    error: errorMessage,
    available,
    isNotFound,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching,
    retry: () => {
      if (query.isFetching) return;
      const failure = { scope, error: query.error };
      setRetryFailure(failure);
      void query.refetch({ cancelRefetch: false }).finally(() => setRetryFailure(current => current === failure ? null : current));
    }
  };
}
