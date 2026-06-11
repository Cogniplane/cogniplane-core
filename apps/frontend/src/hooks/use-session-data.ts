"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { listApprovals } from "../lib/session-api";
import { listArtifacts } from "../lib/artifact-api";
import { listMessages } from "../lib/message-api";
import type { Approval, Artifact, Message } from "@cogniplane/shared-types";
import { queryKeys } from "../lib/query-keys";

type SessionData = {
  messages: Message[];
  artifacts: Artifact[];
  approvals: Approval[];
};

async function loadSessionData(sessionId: string): Promise<SessionData> {
  const [messages, artifacts, approvals] = await Promise.all([
    listMessages(sessionId),
    listArtifacts(sessionId),
    listApprovals(sessionId)
  ]);
  return { messages, artifacts, approvals };
}

export function useSessionData(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
  replacePendingApprovals: (approvals: Approval[]) => void;
}) {
  const { selectedSessionId, onError, replacePendingApprovals } = input;
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);
  const refreshEpochRef = useRef(0);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const sessionDetailQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.sessions.detail(selectedSessionId)
      : ["sessions", "detail", "__no-session__"],
    queryFn: () =>
      selectedSessionId
        ? loadSessionData(selectedSessionId)
        : Promise.resolve<SessionData>({ messages: [], artifacts: [], approvals: [] }),
    enabled: selectedSessionId !== null
  });

  // Clear immediately when the session changes to avoid flashing stale data from
  // the previous session. Must run before the populate effect below so that a
  // cache-hit (synchronous sessionDetailQuery.data) doesn't get wiped after it
  // has already been written.
  useEffect(() => {
    // Clear stale data on session change before the populate effect runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([]);
    setArtifacts([]);
  }, [selectedSessionId]);

  // Populate from query data once it is available (sync on cache hit, async on miss).
  useEffect(() => {
    if (!selectedSessionId) {
      replacePendingApprovals([]);
      return;
    }
    const data = sessionDetailQuery.data;
    if (!data) return;
    if (selectedSessionIdRef.current !== selectedSessionId) return;
    setMessages(data.messages);
    setArtifacts(data.artifacts);
    replacePendingApprovals(data.approvals);
  }, [selectedSessionId, sessionDetailQuery.data, replacePendingApprovals]);

  useEffect(() => {
    if (sessionDetailQuery.error) {
      onError(
        sessionDetailQuery.error instanceof Error
          ? sessionDetailQuery.error.message
          : String(sessionDetailQuery.error)
      );
    }
  }, [sessionDetailQuery.error, onError]);

  const hasInFlightArtifact = artifacts.some(
    (artifact) => artifact.status === "pending" || artifact.status === "processing"
  );

  // Poll artifacts only while something is pending/processing. TanStack Query
  // pauses refetchInterval automatically when the tab is backgrounded.
  const artifactsPollQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.sessions.artifacts(selectedSessionId)
      : ["sessions", "artifacts", "__no-session__"],
    queryFn: () => (selectedSessionId ? listArtifacts(selectedSessionId) : Promise.resolve([])),
    enabled: selectedSessionId !== null && hasInFlightArtifact,
    refetchInterval: hasInFlightArtifact ? 2_000 : false
  });

  useEffect(() => {
    if (!selectedSessionId) return;
    if (!artifactsPollQuery.data) return;
    if (selectedSessionIdRef.current !== selectedSessionId) return;
    setArtifacts(artifactsPollQuery.data);
  }, [artifactsPollQuery.data, selectedSessionId]);

  // Called when a send appends optimistic bubbles: any refresh already in
  // flight predates them and must discard its snapshot instead of landing.
  const invalidateInFlightSessionRefreshes = useCallback(() => {
    refreshEpochRef.current += 1;
  }, []);

  const refreshSessionData = useCallback(
    async (sessionId: string) => {
      // Overlapping refreshes resolve last-call-wins via the epoch.
      const epoch = ++refreshEpochRef.current;
      const nextData = await loadSessionData(sessionId);
      // When superseded, skip the cache write too — setQueryData feeds the
      // populate effect, which would re-apply the stale messages anyway.
      if (refreshEpochRef.current !== epoch) return;
      // Keep the cache in sync so navigating away and back within the stale
      // window serves fresh data instead of the pre-turn snapshot.
      queryClient.setQueryData(queryKeys.sessions.detail(sessionId), nextData);
      if (selectedSessionIdRef.current !== sessionId) return;
      setMessages(nextData.messages);
      setArtifacts(nextData.artifacts);
      replacePendingApprovals(nextData.approvals);
    },
    [queryClient, replacePendingApprovals]
  );

  return {
    messages,
    setMessages,
    artifacts,
    setArtifacts,
    refreshSessionData,
    invalidateInFlightSessionRefreshes,
    isSessionDataReady:
      selectedSessionId !== null && sessionDetailQuery.isSuccess && sessionDetailQuery.data !== undefined
  };
}
