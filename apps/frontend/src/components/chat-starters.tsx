"use client";
// The empty chat offers a few starters. A starter button puts its draft in the
// message box through the widget-draft seam, and the user sends the draft with
// the normal Send button. The host decides when the list shows
// (copilot-chat-host.tsx), and this list only renders it.

import { useId } from "react";

import { CHAT_STARTERS, type ChatStarter } from "./chat-starters.logic";

export function ChatStarters({ onPick }: { onPick: (starter: ChatStarter) => void }) {
  const headingId = useId();
  const hintId = useId();
  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-xl py-6">
      <h2 id={headingId} className="text-base font-semibold text-on-surface">Start with a draft</h2>
      <p className="mt-1 text-sm text-on-surface-variant">
        Choose one to put a draft in the message box. Change it as you like. Nothing is sent until you press Send.
      </p>
      {/* One list with one border. Each row is a button, so a row needs no card. */}
      <ul className="mt-4 divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface">
        {CHAT_STARTERS.map((starter) => (
          <li key={starter.id}>
            <button
              type="button"
              aria-describedby={`${hintId}-${starter.id}`}
              onClick={() => onPick(starter)}
              className="flex min-h-14 w-full flex-col items-start justify-center gap-0.5 px-4 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-surface-container focus-visible:bg-surface-container focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 motion-reduce:transition-none sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <span className="text-sm font-medium text-on-surface">{starter.label}</span>
              {/* The hint is the description of the button, so the name stays the task. */}
              <span id={`${hintId}-${starter.id}`} aria-hidden="true" className="text-sm text-on-surface-variant">{starter.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
