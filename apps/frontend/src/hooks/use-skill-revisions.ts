"use client";

import { useCallback, useRef, useState } from "react";

import type { SkillRevision } from "@cogniplane/shared-types";

export function useSkillRevisions(input: {
  onListRevisions: (skillId: string) => Promise<SkillRevision[]>;
}) {
  const { onListRevisions } = input;
  const [revisionMap, setRevisionMap] = useState<Record<string, SkillRevision[]>>({});
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  const generations = useRef<Record<string, number>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<Record<string, string | undefined>>({});

  const refresh = useCallback(async (skillId: string) => {
    const generation = (generations.current[skillId] ?? 0) + 1;
    generations.current[skillId] = generation;
    setLoading(current => ({ ...current, [skillId]: true }));
    setLoadError(current => ({ ...current, [skillId]: undefined }));
    try {
      const revisions = await onListRevisions(skillId);
      if (generations.current[skillId] === generation) {
        setRevisionMap(current => ({ ...current, [skillId]: revisions }));
      }
      return revisions;
    } catch (error) {
      if (generations.current[skillId] === generation) {
        setLoadError(current => ({ ...current, [skillId]: error instanceof Error ? error.message : "Could not load history." }));
      }
      throw error;
    } finally {
      if (generations.current[skillId] === generation) {
        setLoading(current => ({ ...current, [skillId]: false }));
      }
    }
  }, [onListRevisions]);

  const open = useCallback(async (skillId: string) => {
    selected.current = skillId;
    setExpandedSkillId(skillId);
    try { await refresh(skillId); } catch { /* The selected history shows the read error. */ }
  }, [refresh]);

  const toggle = useCallback(async (skillId: string) => {
    if (selected.current === skillId) {
      selected.current = null;
      setExpandedSkillId(null);
      return;
    }
    selected.current = skillId;
    setExpandedSkillId(skillId);
    if (!revisionMap[skillId]) {
      try { await refresh(skillId); } catch { /* Keep the selected history open for retry. */ }
    }
  }, [refresh, revisionMap]);

  return { revisionMap, expandedSkillId, loading, loadError, toggle, open, refresh };
}
