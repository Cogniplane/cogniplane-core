"use client";

import { useQuery } from "@tanstack/react-query";

import { getAdminSessionDetail } from "../lib/admin-api";
import {
  isRouteNotFoundError,
  toErrorMessage,
  toRouteUnavailableMessage
} from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";

function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "session_not_found";
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

  const error = query.error;
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
    isLoading: query.isLoading
  };
}
