"use client";

import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import type { Approval, Artifact, Message } from "@cogniplane/shared-types";

import { listArtifacts } from "../lib/artifact-api";
import { listMessages } from "../lib/message-api";
import { queryKeys } from "../lib/query-keys";
import { listApprovals } from "../lib/session-api";

type SessionData = {
  messages: Message[];
  hasMoreMessages: boolean;
  artifacts: Artifact[];
  approvals: Approval[];
};

async function loadSessionData(sessionId: string, signal?: AbortSignal): Promise<SessionData> {
  const [messagePage, artifacts, approvals] = await Promise.all([
    listMessages(sessionId, signal),
    listArtifacts(sessionId, signal),
    listApprovals(sessionId, signal)
  ]);
  return {
    messages: messagePage.messages,
    hasMoreMessages: messagePage.hasMore,
    artifacts,
    approvals
  };
}

const EMPTY_SESSION_DATA: SessionData = {
  messages: [],
  hasMoreMessages: false,
  artifacts: [],
  approvals: []
};

export function useSessionData(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
}) {
  const { selectedSessionId, onError } = input;
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
  const hasMoreMessages = sessionData?.hasMoreMessages ?? false;
  const artifacts = sessionData?.artifacts ?? EMPTY_SESSION_DATA.artifacts;
  // Wait for this visit's refetch before seeding the chat with cached history.
  // If it fails, keep the cached transcript available instead of leaving chat blank.
  const isSessionDataReady =
    selectedSessionId !== null &&
    sessionData !== undefined &&
    sessionDetailQuery.isFetchedAfterMount;

  useEffect(() => {
    if (!sessionDetailQuery.error || isCancelledError(sessionDetailQuery.error)) return;
    onError(
      sessionDetailQuery.error instanceof Error
        ? sessionDetailQuery.error.message
        : String(sessionDetailQuery.error)
    );
  }, [sessionDetailQuery.error, onError]);

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
    queryClient.setQueryData<SessionData>(
      queryKeys.sessions.detail(selectedSessionId),
      (current) =>
        current
          ? { ...current, artifacts: artifactsPollQuery.data?.artifacts ?? current.artifacts }
          : current
    );
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
    messages,
    hasMoreMessages,
    artifacts,
    initialApprovals: sessionData?.approvals ?? EMPTY_SESSION_DATA.approvals,
    refreshSessionData,
    isSessionDataReady
  };
}
