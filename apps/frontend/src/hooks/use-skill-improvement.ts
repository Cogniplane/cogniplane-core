"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  buildImproverKickoffPrompt,
  IMPROVER_KICKOFF_STORAGE_PREFIX
} from "../components/improver-session-banner";
import type {
  EffortLevel,
  LaunchSkillImprovementResponse,
  RuntimeProvider,
  SkillImprovementSessionSummary
} from "@cogniplane/shared-types";

export type ImproveTarget = { skillId: string; skillName: string };

export type LaunchNotice = {
  skillId: string;
  sessionId: string;
  includedSessionCount: number;
};

export function useSkillImprovement(input: {
  expandedSkillId: string | null;
  onLaunchImprovement?: (input: {
    skillId: string;
    sessionCount: number;
    provider?: RuntimeProvider | null;
    model?: string | null;
    effort?: EffortLevel | null;
  }) => Promise<LaunchSkillImprovementResponse>;
  onListImprovementSessions?: (skillId: string) => Promise<SkillImprovementSessionSummary[]>;
}) {
  const { expandedSkillId, onLaunchImprovement, onListImprovementSessions } = input;
  const router = useRouter();

  const [target, setTarget] = useState<ImproveTarget | null>(null);
  const [sessionsBySkill, setSessionsBySkill] = useState<
    Record<string, SkillImprovementSessionSummary[]>
  >({});
  const [launchNotice, setLaunchNotice] = useState<LaunchNotice | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Lazy-load improvement history when a skill expands.
  useEffect(() => {
    if (!expandedSkillId || !onListImprovementSessions) return;
    if (sessionsBySkill[expandedSkillId]) return;
    let cancelled = false;
    void (async () => {
      try {
        const sessions = await onListImprovementSessions(expandedSkillId);
        if (cancelled) return;
        setSessionsBySkill((current) => ({ ...current, [expandedSkillId]: sessions }));
      } catch (err) {
        console.error("Failed to load improvement sessions", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedSkillId, onListImprovementSessions, sessionsBySkill]);

  const launch = useCallback(
    async (input: {
      sessionCount: number;
      provider: RuntimeProvider;
      model: string;
      effort: EffortLevel | null;
    }) => {
      if (!target || !onLaunchImprovement) return;
      setLaunchError(null);
      try {
        const result = await onLaunchImprovement({
          skillId: target.skillId,
          sessionCount: input.sessionCount,
          provider: input.provider,
          model: input.model,
          effort: input.effort
        });
        window.localStorage.setItem("cogniplane:model", input.model);
        if (input.effort) {
          window.localStorage.setItem("cogniplane:effort", input.effort);
        } else {
          window.localStorage.removeItem("cogniplane:effort");
        }
        window.localStorage.setItem("cogniplane:selected-session-id:v1", result.sessionId);
        window.sessionStorage.setItem(
          IMPROVER_KICKOFF_STORAGE_PREFIX + result.sessionId,
          buildImproverKickoffPrompt(target.skillName)
        );
        setLaunchNotice({
          skillId: target.skillId,
          sessionId: result.sessionId,
          includedSessionCount: result.includedSessionCount
        });
        setSessionsBySkill((current) => {
          if (!(target.skillId in current)) return current;
          const next = { ...current };
          delete next[target.skillId];
          return next;
        });
        setTarget(null);
        router.push("/");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to launch improver session.";
        setLaunchError(message);
      }
    },
    [onLaunchImprovement, router, target]
  );

  const cancel = useCallback(() => {
    setTarget(null);
    setLaunchError(null);
  }, []);

  const dismissNotice = useCallback(() => setLaunchNotice(null), []);

  return {
    target,
    setTarget,
    launchError,
    launch,
    cancel,
    launchNotice,
    dismissNotice,
    sessionsBySkill
  };
}
