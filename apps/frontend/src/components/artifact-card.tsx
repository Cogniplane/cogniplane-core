"use client";
// ArtifactCard: the one application component of the chat's generative UI
// catalog. The model sets only `artifactId`. The card reads the name, status,
// size, type and PII label from the artifact list of the session that the app
// holds, never from the model. Its one action opens the existing preview, and
// only on a click of the user. To render or update the card fetches nothing
// and starts no run. Without a provider, every card shows that the file is not
// available.

import type { Artifact } from "@cogniplane/shared-types";
import { FileIcon } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { artifactCardPreviewBlock, findSessionArtifact } from "./artifact-card.logic";
import { formatArtifactStatus, formatFileSize } from "./artifact-panel.logic";
import { PiiChip } from "./artifact-pii-chip";

/** What the chat shell gives the cards: the session's artifacts, and the
 *  callback that opens the shared preview of one of them. */
export type ArtifactCardInventory = {
  artifacts: readonly Artifact[];
  onOpenPreview: (artifactId: string) => void;
};

type ArtifactCardContextValue = ArtifactCardInventory & { sessionId: string };

const ArtifactCardContext = createContext<ArtifactCardContextValue | null>(null);
const NO_ARTIFACTS: readonly Artifact[] = [];

/** Gives the cards of one chat the artifacts of that session only. */
export function ArtifactCardProvider({
  sessionId,
  inventory,
  children
}: {
  sessionId: string;
  inventory: ArtifactCardInventory | undefined;
  children: ReactNode;
}) {
  const all = inventory?.artifacts ?? NO_ARTIFACTS;
  const onOpenPreview = inventory?.onOpenPreview;
  const artifacts = useMemo(() => all.filter((artifact) => artifact.sessionId === sessionId), [all, sessionId]);
  const value = useMemo(
    () => (onOpenPreview ? { sessionId, artifacts, onOpenPreview } : null),
    [sessionId, artifacts, onOpenPreview]
  );
  return <ArtifactCardContext.Provider value={value}>{children}</ArtifactCardContext.Provider>;
}

const CARD = "my-2 flex max-w-md items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-3 text-sm";

export function GenerativeArtifactCard({ artifactId }: { artifactId: string }) {
  const context = useContext(ArtifactCardContext);
  const artifact = context ? findSessionArtifact(context.artifacts, context.sessionId, artifactId) : null;

  if (!context || !artifact) {
    return (
      <div role="note" className={CARD}>
        <FileIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-on-surface-variant" />
        <p className="m-0 text-on-surface-variant">This file is not available in this chat.</p>
      </div>
    );
  }

  const block = artifactCardPreviewBlock(artifact);
  const pii = artifact.detail?.pii;

  return (
    <article aria-label={artifact.artifactName} className={CARD}>
      <FileIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-on-surface-variant" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="min-w-0 font-medium text-on-surface [overflow-wrap:anywhere]">{artifact.artifactName}</strong>
          {pii ? <PiiChip pii={pii} /> : null}
        </div>
        <p className="m-0 pt-1 text-xs text-on-surface-variant [overflow-wrap:anywhere]">
          {formatArtifactStatus(artifact.status)} · {formatFileSize(artifact.fileSizeBytes)} · {artifact.mimeType}
        </p>
        {block ? <p className="m-0 pt-1 text-xs text-on-surface-variant">{block}</p> : null}
      </div>
      {/* The button exists only while the artifact of this render can open.
          A list update renders the card again before the next click. */}
      {block ? null : (
        <Button type="button" variant="ghost" size="xs" onClick={() => context.onOpenPreview(artifact.artifactId)}>
          Preview
        </Button>
      )}
    </article>
  );
}
