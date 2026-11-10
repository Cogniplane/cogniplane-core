"use client";
// What the chat area shows when it has no chat to show: no session is
// selected, the session or the chat code is loading, the first load of the
// session failed with nothing cached, or the chat threw an error. The no-model
// notice comes before all of these in the shell, and a cached chat comes
// before the load error.

import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";
import { useEffect } from "react";

import { Button } from "./ui/button";

const NOTICE_FRAME = "flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-4";
const NOTICE_CARD = "mx-auto mt-8 flex w-[min(560px,100%)] flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container-lowest px-8 py-10 text-center";

/** Loading uses the same position as the session notices. */
export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <section role="status" className={NOTICE_FRAME}>
      <p className="mx-auto mt-8 flex w-[min(560px,100%)] items-center justify-center gap-2 px-8 py-10 text-sm text-on-surface-variant">
        <LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
        {label}
      </p>
    </section>
  );
}

export function WorkspaceLoadError({ message, retrying, onRetry }: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section className={NOTICE_FRAME}>
      <div role="alert" className={NOTICE_CARD}>
        <CircleAlertIcon aria-hidden="true" className="size-6 text-danger" />
        <h2 className="text-base font-semibold text-on-surface">This session did not load</h2>
        <p className="max-w-md text-sm text-on-surface-variant">
          The chat, its files and its approvals could not be read. Check your connection, then try again.
        </p>
        <p className="max-w-md text-xs text-on-surface-faint [overflow-wrap:anywhere]">Error: {message}</p>
        <Button type="button" className="aria-disabled:opacity-50" onClick={() => { if (!retrying) onRetry(); }} aria-disabled={retrying || undefined} aria-busy={retrying || undefined}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </section>
  );
}

export function WorkspaceNoSession({ hasSessions, isCreating, onNewSession, onShowSessions }: {
  /** The user has sessions to choose from. */
  hasSessions: boolean;
  isCreating: boolean;
  onNewSession: () => void;
  /** Opens the session sidebar. Absent while it is already open. */
  onShowSessions?: () => void;
}) {
  return (
    <section className={NOTICE_FRAME}>
      <div className={NOTICE_CARD}>
        <h2 className="text-base font-semibold text-on-surface">
          {hasSessions ? "No session selected" : "Start your first session"}
        </h2>
        <p className="max-w-md text-sm text-on-surface-variant">
          {hasSessions
            ? "Start a new session, or open one from your sessions to continue where you left off."
            : "A session keeps one conversation with the agent, with its files and approvals."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={onNewSession} disabled={isCreating} aria-busy={isCreating || undefined}>
            {isCreating ? "Creating…" : "New session"}
          </Button>
          {onShowSessions && hasSessions ? (
            <Button type="button" variant="outline" onClick={onShowSessions}>
              Open sessions
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type ChatRenderErrorProps = {
  isCreating: boolean;
  /** Starts a new session, which leaves the one that failed. */
  onNewSession: () => void;
  /** Opens the session sidebar. Absent while it is already open. */
  onShowSessions?: () => void;
  /** Runs when the notice replaces the chat. */
  onFailure?: () => void;
};

/**
 * The chat of the selected session threw while it rendered or in an effect.
 * Try again renders the same saved messages again, so it can fail again. New
 * session and the session sidebar are the ways out. The notice never shows
 * the error, which can hold message or tool text.
 */
export function WorkspaceRenderError({ isCreating, onRetry, onNewSession, onShowSessions, onFailure }: ChatRenderErrorProps & {
  onRetry: () => void;
}) {
  useEffect(() => {
    onFailure?.();
  }, [onFailure]);
  return (
    <section className={NOTICE_FRAME}>
      <div role="alert" className={NOTICE_CARD}>
        <CircleAlertIcon aria-hidden="true" className="size-6 text-danger" />
        <h2 className="text-base font-semibold text-on-surface">This session could not be shown</h2>
        <p className="max-w-md text-sm text-on-surface-variant">
          An error stopped this chat from displaying. Saved messages and files are not deleted. If the error
          comes back, start a new session or open another one.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" onClick={onRetry}>Try again</Button>
          <Button type="button" onClick={onNewSession} disabled={isCreating} aria-busy={isCreating || undefined}>
            {isCreating ? "Creating…" : "New session"}
          </Button>
          {onShowSessions ? (
            <Button type="button" variant="outline" onClick={onShowSessions}>
              Open sessions
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ChatRenderFailure(props: ChatRenderErrorProps, { reset }: ErrorInfo) {
  return <WorkspaceRenderError {...props} onRetry={reset} />;
}

/**
 * Wraps the chat of one session. Key it by session id, so that a switch to
 * another session starts with no error.
 */
export const ChatRenderBoundary = catchError(ChatRenderFailure);
