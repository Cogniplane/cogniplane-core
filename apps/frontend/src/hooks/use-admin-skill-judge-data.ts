"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import {
  getSkillJudgeAdmin,
  updateSkillJudgeAdmin,
  type SkillJudgeSettings
} from "../lib/admin-api";
import { buildApiUrl, createApiHeaders } from "../lib/api-client";
import { toErrorMessage } from "../lib/error-utils";

const queryKey = ["admin", "skill-judge"] as const;

/**
 * Live progress event mirrored from `JudgeProgressEvent` on the backend.
 * Kept loose (`Record<string, unknown>` for extra fields) so the frontend
 * doesn't have to track every backend type — the page renders only the
 * fields it knows about.
 */
export type RunProgressEvent =
  | { kind: "tick_started"; tenantId: string | null }
  | { kind: "eligible_found"; count: number; tenantId: string | null }
  | { kind: "submit_skipped_inflight_batches"; pendingBatchCount: number }
  | {
      kind: "session_claimed";
      tenantId: string;
      sessionId: string;
      provider: string;
      model: string;
      mode: "sync" | "batch";
    }
  | { kind: "session_skipped_no_skills"; tenantId: string; sessionId: string }
  | {
      kind: "session_completed";
      tenantId: string;
      sessionId: string;
      skillsJudged: number;
      invokedCount: number;
    }
  | { kind: "session_failed"; tenantId: string; sessionId: string; error: string }
  | {
      kind: "batch_submitted";
      provider: string;
      model: string;
      batchId: string;
      sessionCount: number;
    }
  | { kind: "tick_completed"; durationMs: number };

export type RunLogEntry =
  | { type: "progress"; event: RunProgressEvent; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; at: number };

export function useAdminSkillJudgeData() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: getSkillJudgeAdmin
  });

  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient]);

  const save = useCallback(
    async (settings: SkillJudgeSettings) => {
      setSaving(true);
      setSaveError(null);
      try {
        await updateSkillJudgeAdmin(settings);
        setSavedAt(Date.now());
        await queryClient.invalidateQueries({ queryKey });
      } catch (err) {
        setSaveError(toErrorMessage(err, "Failed to save skill judge settings."));
      } finally {
        setSaving(false);
      }
    },
    [queryClient]
  );

  const runNow = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunLog([]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(buildApiUrl("/admin/skill-judge/run"), {
        method: "POST",
        headers: createApiHeaders(undefined, null),
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        setRunLog((prev) => [
          ...prev,
          {
            type: "error",
            message: `Run failed: ${response.status} ${text || response.statusText}`,
            at: Date.now()
          }
        ]);
        return;
      }

      // Parse the SSE stream by hand. EventSource would be simpler but
      // doesn't support Authorization headers, which we need for WorkOS auth.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Each SSE frame is separated by a blank line.
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          let event = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join("\n");

          if (event === "progress" && data) {
            try {
              const parsed = JSON.parse(data) as RunProgressEvent;
              setRunLog((prev) => [...prev, { type: "progress", event: parsed, at: Date.now() }]);
            } catch {
              setRunLog((prev) => [
                ...prev,
                { type: "error", message: `Could not parse progress frame: ${data}`, at: Date.now() }
              ]);
            }
          } else if (event === "error" && data) {
            try {
              const parsed = JSON.parse(data) as { message?: string };
              setRunLog((prev) => [
                ...prev,
                { type: "error", message: parsed.message ?? "Unknown error.", at: Date.now() }
              ]);
            } catch {
              setRunLog((prev) => [
                ...prev,
                { type: "error", message: data, at: Date.now() }
              ]);
            }
          } else if (event === "done") {
            setRunLog((prev) => [...prev, { type: "done", at: Date.now() }]);
          }

          separator = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setRunLog((prev) => [
          ...prev,
          { type: "error", message: toErrorMessage(err, "Stream failed."), at: Date.now() }
        ]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Pull fresh stats after the run.
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient, running]);

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    loadError: query.error ? toErrorMessage(query.error, "Failed to load skill judge.") : null,
    refetch,
    saving,
    saveError,
    savedAt,
    save,
    running,
    runLog,
    runNow,
    cancelRun
  };
}
