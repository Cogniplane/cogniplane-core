"use client";

import { useEffect, useMemo, useState } from "react";
import { SafeMarkdown } from "./safe-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";

import { getSkillRevisionFile, type SkillRevisionFilePreview } from "../lib/admin-api";
import { getPreviewLanguage, isImageArtifact } from "../lib/artifact-preview";
import { parseCsvPreview } from "../lib/csv-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Props = {
  skillId: string;
  skillRevisionId: number;
  path: string;
  onClose: () => void;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; file: SkillRevisionFilePreview }
  | { status: "error"; message: string };

const CSV_PREVIEW_ROW_LIMIT = 100;

export function AdminSkillFileModal({ skillId, skillRevisionId, path, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [csvMode, setCsvMode] = useState<"table" | "raw">("table");

  useEffect(() => {
    let cancelled = false;
    // Async fetch-on-mount; loading state is the start of the external sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });
    getSkillRevisionFile({ skillId, skillRevisionId, path })
      .then((result) => {
        if (cancelled) return;
        setState({ status: "ready", file: result.file });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load file.";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, skillRevisionId, path]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="flex flex-row items-center justify-between border-b border-outline-variant px-6 py-4">
          <DialogTitle className="truncate text-base">{path}</DialogTitle>
          {state.status === "ready" && state.file.contentType === "text/csv" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCsvMode((mode) => (mode === "table" ? "raw" : "table"))}
            >
              {csvMode === "table" ? "Show raw" : "Show table"}
            </Button>
          ) : null}
        </DialogHeader>

        <div className="flex-1 overflow-auto p-6">
          {state.status === "loading" ? (
            <p className="text-sm text-on-surface-variant">Loading…</p>
          ) : state.status === "error" ? (
            <p className="text-sm text-danger">{state.message}</p>
          ) : (
            <FileBody file={state.file} csvMode={csvMode} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileBody({
  file,
  csvMode
}: {
  file: SkillRevisionFilePreview;
  csvMode: "table" | "raw";
}) {
  const { contentType, encoding, content } = file;

  if (encoding === "base64" && isImageArtifact(contentType)) {
    return (
      // next/image cannot optimize data: URIs; the image is already inlined as base64.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`data:${contentType};base64,${content}`}
        alt={file.path}
        className="mx-auto max-h-full max-w-full"
      />
    );
  }

  if (encoding === "base64") {
    return (
      <p className="text-sm text-danger">
        Binary file ({contentType}, {file.sizeBytes} bytes). Preview not available.
      </p>
    );
  }

  if (contentType === "text/csv" && csvMode === "table") {
    return <CsvTable content={content} />;
  }

  if (contentType === "text/markdown") {
    return (
      <div className="prose prose-sm max-w-none">
        <SafeMarkdown>{content}</SafeMarkdown>
      </div>
    );
  }

  const language = getPreviewLanguage(contentType);
  return (
    <SyntaxHighlighter
      language={language}
      style={atomOneDark}
      customStyle={{ margin: 0, borderRadius: 4, fontSize: "0.85rem", lineHeight: 1.6 }}
      wrapLongLines
    >
      {content}
    </SyntaxHighlighter>
  );
}

function CsvTable({ content }: { content: string }) {
  const parsed = useMemo(
    () => parseCsvPreview(content, { maxRows: CSV_PREVIEW_ROW_LIMIT }),
    [content]
  );

  const columnCount = Math.max(
    parsed.header.length,
    ...parsed.rows.map((row) => row.length)
  );
  const columns = Array.from({ length: columnCount }, (_, index) => index);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
          {parsed.truncated
            ? `Showing first ${parsed.rows.length} of ${parsed.totalRowsSeen} rows`
            : `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`}
        </span>
        <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
          {columnCount} columns
        </span>
      </div>
      <div className="overflow-auto rounded-md border border-outline-variant">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-surface-container-low">
            <tr>
              {columns.map((index) => (
                <th
                  key={index}
                  className="border-b border-outline-variant px-3 py-2 text-left font-mono font-semibold text-on-surface"
                >
                  {parsed.header[index] ?? `col${index + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parsed.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-outline-variant last:border-b-0">
                {columns.map((index) => (
                  <td key={index} className="px-3 py-1.5 font-mono text-on-surface-variant">
                    {row[index] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
