"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";

import { Button } from "./ui/button";
import { RenderBoundary } from "./render-boundary";
import { SafeMarkdown } from "./safe-markdown";
import { getPreviewLanguage, isImageArtifact, isPdfArtifact } from "../lib/artifact-preview";

// react-syntax-highlighter's default export eagerly bundles every highlight.js
// language grammar (100KB+). It's only reached for the non-image/markdown/html
// fallback branch, so split it into its own chunk fetched on demand instead of
// shipping it in the hot chat route bundle.
const CodeBlock = dynamic(() => import("./artifact-code-block"), { ssr: false });
import { getInertHtmlPreviewProps } from "./artifact-preview-modal.logic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

export function ArtifactPreviewModal(props: {
  artifactName: string;
  mimeType: string;
  content: string | null;
  imageUrl: string | null;
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const language = getPreviewLanguage(props.mimeType);
  const htmlPreviewProps =
    props.mimeType === "text/html" && props.content !== null
      ? getInertHtmlPreviewProps(props.content)
      : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent ref={dialogRef} scrollBody={false}
        onOpenAutoFocus={(event) => {
          if (!htmlPreviewProps) return;
          // Keys in the sandboxed document do not reach the parent dialog.
          event.preventDefault();
          dialogRef.current?.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.focus();
        }}
        className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-[min(56rem,calc(100%-2rem))]">
        <DialogHeader className="shrink-0 border-b border-outline-variant px-6 py-4 pr-14">
          <DialogTitle className="truncate text-base">{props.artifactName}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto p-6">
          {/* The renderers below read file content. When one throws, the
              title and Close stay usable. Each caller mounts the modal for one
              preview; the key also resets the boundary if the file changes. */}
          <RenderBoundary key={JSON.stringify([props.artifactName, props.mimeType])} className="my-0"
            title="This preview could not be shown"
            description="An error stopped this file from displaying. Try again, or close the preview and download the file.">
            {props.error ? (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-danger">{props.error}</p>
                {props.onRetry ? <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>Retry preview</Button> : null}
              </div>
            ) : props.content === null && props.imageUrl === null ? (
              <p role="status" className="text-sm text-on-surface-variant">Loading preview…</p>
            ) : isImageArtifact(props.mimeType) && props.imageUrl ? (
              // Artifact images are short-lived signed URLs of unknown dimensions/origin; next/image
              // would require remotePatterns config and explicit width/height we don't have.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={props.imageUrl}
                alt={props.artifactName}
                className="mx-auto max-h-[calc(85dvh-7rem)] max-w-full object-contain"
              />
            ) : props.mimeType === "text/markdown" ? (
              <div className="prose prose-sm max-w-none">
                <SafeMarkdown>{props.content!}</SafeMarkdown>
              </div>
            ) : htmlPreviewProps ? (
              <iframe
                title={props.artifactName}
                srcDoc={htmlPreviewProps.srcDoc}
                // Never add allow-scripts or allow-same-origin: artifact HTML is
                // agent-authored and may contain prompt-injected active content.
                sandbox={htmlPreviewProps.sandbox}
                className="h-[min(60dvh,calc(85dvh-7rem))] w-full rounded border border-outline-variant focus-within:outline-none focus-within:ring-[3px] focus-within:ring-ring/50"
              />
            ) : (
              <CodeBlock
                language={isPdfArtifact(props.mimeType) ? "plaintext" : language}
                code={props.content ?? ""}
              />
            )}
          </RenderBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
