"use client";

import { SafeMarkdown } from "./safe-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { getPreviewLanguage, isImageArtifact, isPdfArtifact } from "../lib/artifact-preview";
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
          ) : props.mimeType === "text/html" && props.content !== null ? (
            <iframe
              title={props.artifactName}
              srcDoc={props.content}
              sandbox="allow-scripts"
              className="h-[60vh] w-full rounded border border-outline-variant"
            />
          ) : (
            <SyntaxHighlighter
              language={isPdfArtifact(props.mimeType) ? "plaintext" : language}
              style={atomOneDark}
              customStyle={{ margin: 0, borderRadius: 4, fontSize: "0.85rem", lineHeight: 1.6 }}
              wrapLongLines
            >
              {props.content ?? ""}
            </SyntaxHighlighter>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
