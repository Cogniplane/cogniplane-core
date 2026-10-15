"use client";
// Shown instead of the chat for a session that the chat cannot reopen: it was
// saved in the previous history format, or its format is not one that this
// version knows (also when the record has no format). The age of an unknown
// format is not known, so its notice does not call it earlier or newer. The
// server also refuses to continue or reopen such a session. Its rows stay
// stored, so the clipboard copy and the admin audit still read them.

import type { TranscriptFormat } from "@cogniplane/shared-types";

import { Button } from "./ui/button";

export function TranscriptFormatNotice({ format, isCreating, onNewSession }: {
  format: TranscriptFormat | undefined;
  isCreating: boolean;
  onNewSession: () => void;
}) {
  const earlier = format === "legacy";
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-4">
      <div className="mx-auto mt-8 flex w-[min(560px,100%)] flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container-lowest px-8 py-10 text-center shadow-sm">
        <h2 className="text-lg font-semibold text-on-surface">
          {earlier ? "This chat uses an earlier history format" : "This chat uses an unsupported history format"}
        </h2>
        <p className="max-w-md text-sm text-on-surface-variant">
          {earlier
            ? "Cogniplane saved this chat before a change to how chats are stored. The chat stays saved, but you cannot open or continue it here. To keep its text, use Copy session to clipboard."
            : "This version of Cogniplane cannot open or continue this chat. The chat stays saved. To keep its text, use Copy session to clipboard."}
        </p>
        <Button type="button" onClick={onNewSession} disabled={isCreating}>
          New session
        </Button>
      </div>
    </section>
  );
}
