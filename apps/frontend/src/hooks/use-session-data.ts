"use client";

import { isCancelledError, replaceEqualDeep, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import type { Approval, Artifact, Message } from "@cogniplane/shared-types";

import { savedSideState, type SavedSideState } from "../components/agui-transcript";
import { nextReadOrder } from "../lib/agui/read-order";
import { listArtifacts } from "../lib/artifact-api";
import { listMessages } from "../lib/message-api";
import { queryKeys } from "../lib/query-keys";
import { listApprovals } from "../lib/session-api";

type SessionData = {
  messages: Message[];
  artifacts: Artifact[];
  approvals: Approval[];
  /** The read order of the request, taken before it starts. The chat compares
   *  it with its live events (lib/agui/read-order.ts). */
  readOrder: number;
};

async function loadSessionData(sessionId: string, signal?: AbortSignal): Promise<SessionData> {
  const readOrder = nextReadOrder();
  const [messagePage, artifacts, approvals] = await Promise.all([
    listMessages(sessionId, signal),
    listArtifacts(sessionId, signal),
    listApprovals(sessionId, signal)
  ]);
  return {
    messages: messagePage.messages,
    artifacts,
    approvals,
    readOrder
  };
}

const EMPTY_SESSION_DATA: SessionData = {
  messages: [],
  artifacts: [],
  approvals: [],
  readOrder: 0
};

export function useSessionData(input: {
  selectedSessionId: string | null;
}) {
  const { selectedSessionId } = input;
  const queryClient = useQueryClient();

  const sessionDetailQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.sessions.detail(selectedSessionId)
      : ["sessions", "detail", "__no-session__"],
    queryFn: ({ signal }) => {
      if (!selectedSessionId) return Promise.resolve(EMPTY_SESSION_DATA);
      return loadSessionData(selectedSessionId, signal);
    },
    enabled: selectedSessionId !== null,
    staleTime: 0
  });

  const sessionData = selectedSessionId ? sessionDetailQuery.data : undefined;
  const messages = sessionData?.messages ?? EMPTY_SESSION_DATA.messages;
  const artifacts = sessionData?.artifacts ?? EMPTY_SESSION_DATA.artifacts;
  // The chat does not wait for this data: its connection shows the history.
  // The chat takes the saved side state only from a fetch of this visit, so
  // that an approval of an earlier visit does not show as open. If that fetch
  // fails, the cached data applies.
  const isSessionDataReady =
    selectedSessionId !== null &&
    sessionData !== undefined &&
    sessionDetailQuery.isFetchedAfterMount;
  // An artifact poll writes a new data object with the same messages and
  // approvals. It must not apply the side state again.
  const savedMessages = sessionData?.messages;
  const savedApprovals = sessionData?.approvals;
  const savedReadOrder = sessionData?.readOrder;
  const saved = useMemo<SavedSideState | undefined>(
    () => isSessionDataReady && savedMessages && savedApprovals && savedReadOrder !== undefined
      ? savedSideState({ messages: savedMessages, approvals: savedApprovals, readOrder: savedReadOrder })
      : undefined,
    [isSessionDataReady, savedMessages, savedApprovals, savedReadOrder]
  );

  const loadError = sessionDetailQuery.error && !isCancelledError(sessionDetailQuery.error)
    ? sessionDetailQuery.error instanceof Error
      ? sessionDetailQuery.error.message
      : String(sessionDetailQuery.error)
    : null;

  const hasInFlightArtifact = artifacts.some(
    (artifact) => artifact.status === "pending" || artifact.status === "processing"
  );

  const artifactsPollQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.sessions.artifacts(selectedSessionId)
      : ["sessions", "artifacts", "__no-session__"],
    queryFn: async ({ signal }) => {
      if (!selectedSessionId) return undefined;
      // Reject a poll if a newer detail result lands before it returns.
      // Use the update counter: separate writes can share a millisecond timestamp.
      const detailDataUpdateCount =
        queryClient.getQueryState(queryKeys.sessions.detail(selectedSessionId))
          ?.dataUpdateCount ?? 0;
      return {
        artifacts: await listArtifacts(selectedSessionId, signal),
        detailDataUpdateCount
      };
    },
    enabled: selectedSessionId !== null && hasInFlightArtifact,
    refetchInterval: hasInFlightArtifact ? 2_000 : false
  });

  useEffect(() => {
    if (!selectedSessionId || !isSessionDataReady || !artifactsPollQuery.data) return;
    const detailState = queryClient.getQueryState(
      queryKeys.sessions.detail(selectedSessionId)
    );
    if (artifactsPollQuery.data.detailDataUpdateCount !== detailState?.dataUpdateCount) {
      return;
    }
    const detailKey = queryKeys.sessions.detail(selectedSessionId);
    const current = queryClient.getQueryData<SessionData>(detailKey);
    if (!current) return;
    const artifacts = replaceEqualDeep(current.artifacts, artifactsPollQuery.data.artifacts);
    if (artifacts === current.artifacts) return;
    queryClient.setQueryData<SessionData>(detailKey, { ...current, artifacts });
  }, [artifactsPollQuery.data, isSessionDataReady, queryClient, selectedSessionId]);

  const refreshSessionData = useCallback(
    async (sessionId: string) => {
      const queryKey = queryKeys.sessions.detail(sessionId);
      void queryClient.cancelQueries({ queryKey, exact: true });
      try {
        await queryClient.fetchQuery({
          queryKey,
          queryFn: ({ signal }) => loadSessionData(sessionId, signal),
          staleTime: 0
        });
      } catch (error) {
        if (!isCancelledError(error)) throw error;
      }
    },
    [queryClient]
  );

  return {
    loadError,
    messages,
    artifacts,
    /** The pending approvals of the saved data, for the shell while no chat
     *  reports its own count. */
    savedApprovals: savedApprovals ?? EMPTY_SESSION_DATA.approvals,
    /** The side state for the chat, from a fetch of this visit. */
    saved,
    refreshSessionData,
    /** The session's data is known, from this visit or from the cache. */
    hasSessionData: sessionData !== undefined
  };
}
