"use client";

import { useCallback, useState } from "react";

import type { SkillRevision } from "@cogniplane/shared-types";

export function useSkillRevisions(input: {
  onListRevisions: (skillId: string) => Promise<SkillRevision[]>;
}) {
  const { onListRevisions } = input;

  const [revisionMap, setRevisionMap] = useState<Record<string, SkillRevision[]>>({});
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<Record<string, string>>({});

  const setLoadErrorFor = useCallback((skillId: string, message: string | null) => {
    setLoadError((current) => {
      if (message === null) {
        if (!(skillId in current)) return current;
        const { [skillId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [skillId]: message };
    });
  }, []);

  const refresh = useCallback(
    async (skillId: string) => {
      const revisions = await onListRevisions(skillId);
      setRevisionMap((current) => ({ ...current, [skillId]: revisions }));
      return revisions;
    },
    [onListRevisions]
  );

  const toggle = useCallback(
    async (skillId: string) => {
      if (expandedSkillId === skillId) {
        setExpandedSkillId(null);
        setLoadErrorFor(skillId, null);
        return;
      }
      setLoadErrorFor(skillId, null);
      if (!revisionMap[skillId]) {
        try {
          await refresh(skillId);
        } catch (caughtError) {
          console.error("Failed to load skill revisions", caughtError);
          const message =
            caughtError instanceof Error ? caughtError.message : "Failed to load revisions.";
          setLoadErrorFor(skillId, message);
          return;
        }
      }
      setExpandedSkillId(skillId);
    },
    [expandedSkillId, refresh, revisionMap, setLoadErrorFor]
  );

  const open = useCallback(async (skillId: string) => {
    try {
      await refresh(skillId);
      setLoadErrorFor(skillId, null);
      setExpandedSkillId(skillId);
    } catch (caughtError) {
      setLoadErrorFor(skillId, caughtError instanceof Error ? caughtError.message : "Failed to load revisions.");
    }
  }, [refresh, setLoadErrorFor]);

  return {
    revisionMap,
    expandedSkillId,
    loadError,
    toggle,
    open,
    refresh
  };
}
