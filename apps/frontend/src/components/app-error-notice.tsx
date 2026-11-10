"use client";

// The notice of the route error page (app/error.tsx) and the global error page
// (app/global-error.tsx). The global error page renders it without the app
// providers, so it reads no auth, query or toast state. It never shows the
// error text or stack, which can hold tool output or server details.

import { CircleAlertIcon } from "lucide-react";

import { NEW_SESSION_HREF } from "../lib/new-session-link";
import { Button } from "./ui/button";

/** The digest that Next.js adds to a server error. It names the server log
 *  entry and holds no error text. */
function errorReference(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("digest" in error)) return null;
  const { digest } = error as { digest?: unknown };
  return typeof digest === "string" && digest.length > 0 ? digest : null;
}

export function AppErrorNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const reference = errorReference(error);
  return (
    <main className="flex min-h-dvh justify-center bg-surface px-4 py-16">
      <div role="alert" className="flex h-fit w-[min(560px,100%)] flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container-lowest px-8 py-10 text-center">
        <CircleAlertIcon aria-hidden="true" className="size-6 text-danger" />
        <h1 className="text-base font-semibold text-on-surface">This page stopped working</h1>
        <p className="max-w-md text-sm text-on-surface-variant">
          An error stopped Cogniplane from showing this page. Saved sessions and files are not deleted.
        </p>
        <p className="max-w-md text-sm text-on-surface-variant">
          If the error comes back, start a new session. The workspace then opens without the session that
          was open.
        </p>
        {reference ? (
          <p className="text-xs text-on-surface-faint">
            Reference: <span className="font-mono [overflow-wrap:anywhere]">{reference}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={onRetry}>Try again</Button>
          {/* A full page load: the app state that failed is not kept. */}
          <Button asChild variant="outline"><a href={NEW_SESSION_HREF}>New session</a></Button>
        </div>
      </div>
    </main>
  );
}
