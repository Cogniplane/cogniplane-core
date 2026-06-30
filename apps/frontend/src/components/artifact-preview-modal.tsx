"use client";

import dynamic from "next/dynamic";

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
}) {
  const language = getPreviewLanguage(props.mimeType);
  const htmlPreviewProps =
    props.mimeType === "text/html" && props.content !== null
      ? getInertHtmlPreviewProps(props.content)
      : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-outline-variant px-6 py-4">
          <DialogTitle className="truncate text-base">{props.artifactName}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto p-6">
          {props.error ? (
            <p className="text-sm text-danger">{props.error}</p>
          ) : props.content === null && props.imageUrl === null ? (
            <p className="text-sm text-on-surface-variant">Loading…</p>
          ) : isImageArtifact(props.mimeType) && props.imageUrl ? (
            // Artifact images are short-lived signed URLs of unknown dimensions/origin; next/image
            // would require remotePatterns config and explicit width/height we don't have.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={props.imageUrl}
              alt={props.artifactName}
              className="mx-auto max-h-full max-w-full"
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
              className="h-[60vh] w-full rounded border border-outline-variant"
            />
          ) : (
            <CodeBlock
              language={isPdfArtifact(props.mimeType) ? "plaintext" : language}
              code={props.content ?? ""}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
