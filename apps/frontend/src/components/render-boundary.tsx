"use client";

// An error boundary for one piece of content that model output, tool output
// or a file controls: a tool view, a side panel view, a file preview. A
// failure stays in that piece, and the controls around it (Close, the header,
// the composer) keep working.
//
// A boundary catches errors that its children throw while they render and in
// their effects. It does not catch errors in event handlers or in async code
// such as a fetch callback; that code must handle its own errors. The notice
// never shows the error, which can hold tool output or file text.

import { CircleAlertIcon } from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";

import { cn } from "@/lib/cn";
import { Button } from "./ui/button";

function RenderFailure(
  { title, description, className }: { title: string; description: string; className?: string },
  { reset }: ErrorInfo
) {
  return (
    <div role="alert" className={cn("my-2 rounded-md border border-outline-variant bg-surface-container-low p-4 text-sm", className)}>
      <p className="flex items-center gap-2 font-semibold text-on-surface">
        <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
        {title}
      </p>
      <p className="mt-1 text-on-surface-variant">{description}</p>
      {/* reset renders the same content again, once per click. retry() would
          also refresh the route from the server, which client-side content
          does not need. */}
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={reset}>Try again</Button>
    </div>
  );
}

/**
 * Wraps one piece of content. Give it a `key` with the identity of that
 * content, so that other content starts with no error.
 */
export const RenderBoundary = catchError(RenderFailure);
