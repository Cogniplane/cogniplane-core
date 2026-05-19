"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchSessionImprovementContext,
  type SessionImprovementContext
} from "../lib/api-client";
import { createArtifactDownload, fetchArtifactContent } from "../lib/artifact-api";
import type { Artifact, Session } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";

export const IMPROVER_PREFILL_STORAGE_KEY = "cogniplane_skill_editor_prefill";
export const IMPROVER_KICKOFF_STORAGE_PREFIX = "cogniplane:improver-kickoff:";

export function buildImproverKickoffPrompt(skillName: string): string {
  return [
    `Begin the skill improvement workflow for **${skillName}**.`,
    "",
    "1. Use `read_text_artifact` to load the `skill-improvement-corpus-...` artifact attached to this session.",
    "2. Identify patterns in how the skill was actually used — wins, misses, mis-fires, ignored triggers, user corrections.",
    "3. Propose specific changes to the SKILL.md, citing session id + message id from the corpus for each suggestion.",
    "4. Ask me clarifying questions about goals and constraints before drafting the final improved SKILL.md.",
    "",
    "Do not call `write_artifact` until I have agreed on the direction."
  ].join("\n");
}

export type ImproverEditorPrefill = {
  skillId: string;
  instructions: string;
  artifactName: string;
  fromSessionId: string;
};

function isMarkdownArtifact(artifact: Artifact): boolean {
  if (artifact.mimeType?.toLowerCase().startsWith("text/markdown")) return true;
  return artifact.artifactName.toLowerCase().endsWith(".md");
}

function isCorpusArtifact(artifact: Artifact): boolean {
  return artifact.artifactName.startsWith("skill-improvement-corpus-");
}

function pickImprovedSkillArtifact(artifacts: Artifact[]): Artifact | null {
  const candidates = artifacts.filter(
    (a) => a.status === "ready" && isMarkdownArtifact(a) && !isCorpusArtifact(a)
  );
  if (candidates.length === 0) return null;
  // Most recent first — `createdAt` is ISO-8601 so string comparison sorts correctly.
  candidates.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  return candidates[0];
}

export function ImproverSessionBanner(props: {
  session: Session;
  artifacts: Artifact[];
  onError: (message: string) => void;
}) {
  const { session, artifacts, onError } = props;
  const [context, setContext] = useState<SessionImprovementContext | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "ready">("idle");

  useEffect(() => {
    let cancelled = false;
    // Reset on session change before kicking off the async fetch below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContext(null);
    setCopyState("idle");
    if (session.purpose !== "skill_improvement") return;
    void fetchSessionImprovementContext(session.sessionId).then((next) => {
      if (!cancelled) setContext(next);
    });
    return () => {
      cancelled = true;
    };
  }, [session.sessionId, session.purpose]);

  const eligible = useMemo(() => pickImprovedSkillArtifact(artifacts), [artifacts]);

  const handleCopy = useCallback(async () => {
    if (!context || !eligible) return;
    setIsCopying(true);
    try {
      const handle = await createArtifactDownload(eligible.artifactId);
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
      const text = await fetchArtifactContent(`${apiBase}${handle.url}`);
      const prefill: ImproverEditorPrefill = {
        skillId: context.skillId,
        instructions: text,
        artifactName: eligible.artifactName,
        fromSessionId: session.sessionId
      };
      window.sessionStorage.setItem(IMPROVER_PREFILL_STORAGE_KEY, JSON.stringify(prefill));
      setCopyState("ready");
      window.location.assign("/admin/skills");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load improved SKILL.md.";
      onError(message);
    } finally {
      setIsCopying(false);
    }
  }, [context, eligible, onError, session.sessionId]);

  if (session.purpose !== "skill_improvement") return null;

  const skillLabel = context?.skillName ?? context?.skillId ?? "skill";

  return (
    <div
      role="region"
      aria-label="Skill improvement session"
      className="mx-6 mt-4 flex flex-col gap-3 rounded-lg border-l-4 border-l-accent bg-accent-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-1">
        <strong className="text-sm font-semibold text-on-surface">
          Improvement session for skill {skillLabel}
        </strong>
        <span className="text-xs text-on-surface-variant">
          The corpus artifact is preloaded as context. Ask the agent to write the improved
          SKILL.md as an artifact, then copy it back to the editor.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href="/admin/skills">Back to skills</a>
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!context || !eligible || isCopying}
          onClick={() => void handleCopy()}
          title={
            !eligible
              ? "Waiting for the agent to write an improved .md artifact in this session."
              : `Copy ${eligible.artifactName} into the inline skill editor.`
          }
        >
          {isCopying || copyState === "ready"
            ? "Opening editor…"
            : eligible
              ? "Copy SKILL.md to editor"
              : "Awaiting SKILL.md…"}
        </Button>
      </div>
    </div>
  );
}
