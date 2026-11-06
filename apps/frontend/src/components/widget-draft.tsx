"use client";
// How a tool view, or an action of the app in generated UI or in the empty
// chat, puts a draft in the chat message box.
//
// The chat host owns the text of its message box. The composer slot binds
// its controlled value and setter here. A tool view reaches the box through
// this binding and never accesses CopilotKit internals. The text goes in as a
// draft only. The user sends it with the normal Send button, which sends the
// text that the box holds at that time.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "./ui/button";
import {
  DRAFT_WARNING_TEXT,
  appendToDraft,
  inspectDraft
} from "./widget-draft.logic";

type ComposerBinding = { value: string; setValue: (value: string) => void };

/** What wrote the draft. A tool view is an MCP App widget. A generated view
 *  is app-owned UI in a view that the agent made, such as a Checklist. An app
 *  starter is fixed text of the app, in the empty chat (chat-starters.logic.ts). */
export type WidgetDraftOrigin = "tool-view" | "generated-view" | "app-starter";

export type WidgetDraftRequest = {
  text: string;
  /** Names the tool view or the generated view in the notice. */
  source: string;
  /** "tool-view" when left out. */
  origin?: WidgetDraftOrigin;
  /** Add the text after a draft of the user. Without it, a draft that has
   *  text stops the request. */
  append: boolean;
};

/** `occupied`: the box holds a draft and nothing changed.
 *  `unavailable`: no message box takes a draft now. */
export type WidgetDraftPlacement = "placed" | "occupied" | "unavailable";

export type WidgetDraftSeam = {
  place: (request: WidgetDraftRequest) => WidgetDraftPlacement;
};

export type WidgetDraftComposer = {
  /** The composer slot binds its box here, and unbinds it when it goes away. */
  bind: (binding: ComposerBinding | null) => void;
  /** The view that wrote the draft, while the notice shows. */
  source: string | null;
  origin: WidgetDraftOrigin;
  /** The box that is bound, or was bound last, holds text. */
  occupied: boolean;
  /** The draft is gone or sent. The notice goes away. */
  end: () => void;
  /** Restores the explanation saved with composer text. */
  restore: (written: { source: string; origin: WidgetDraftOrigin } | null) => void;
};

export function useWidgetDraft(canPlace: boolean): { seam: WidgetDraftSeam; composer: WidgetDraftComposer } {
  const bindingRef = useRef<ComposerBinding | null>(null);
  const canPlaceRef = useRef(canPlace);
  const [written, setWritten] = useState<{ source: string; origin: WidgetDraftOrigin } | null>(null);
  const [occupied, setOccupied] = useState(false);
  // A layout effect runs in the commit that shows the new state. A passive
  // effect runs later, so a click on a button that this render just showed
  // could still meet the old state.
  useLayoutEffect(() => {
    canPlaceRef.current = canPlace;
  }, [canPlace]);

  const place = useCallback((request: WidgetDraftRequest): WidgetDraftPlacement => {
    const binding = bindingRef.current;
    if (!binding || !canPlaceRef.current) return "unavailable";
    const hasDraft = binding.value.trim() !== "";
    if (hasDraft && !request.append) return "occupied";
    const next = hasDraft ? appendToDraft(binding.value, request.text) : request.text;
    binding.setValue(next);
    // A second request before the next render must see this text.
    bindingRef.current = { ...binding, value: next };
    setOccupied(next.trim() !== "");
    setWritten({ source: request.source, origin: request.origin ?? "tool-view" });
    return "placed";
  }, []);
  const bind = useCallback((binding: ComposerBinding | null) => {
    bindingRef.current = binding;
    // An unbind keeps the last answer. The consumers also need a bound box, and
    // the next bind sets it again. This way a key press that changes nothing
    // renders nothing.
    if (binding) setOccupied(binding.value.trim() !== "");
  }, []);
  const end = useCallback(() => setWritten(null), []);

  const seam = useMemo(() => ({ place }), [place]);
  const source = written?.source ?? null;
  const origin = written?.origin ?? "tool-view";
  const composer = useMemo(() => ({ bind, source, origin, occupied, end, restore: setWritten }), [bind, source, origin, occupied, end]);
  return { seam, composer };
}

const ORIGIN_TEXT: Record<WidgetDraftOrigin, { name: string; explanation: string }> = {
  "tool-view": { name: "Draft from a tool view", explanation: "A tool view wrote this text. You did not." },
  "generated-view": { name: "Draft from a generated view", explanation: "The app wrote this text from the values in the view." },
  "app-starter": { name: "Starter draft", explanation: "The app put starter text in the message box." }
};

/** Shows near the message box while it holds text from a view. It reads the
 *  draft as it is now, so it follows the edits of the user.
 *
 *  The composer scrolls this notice when its chat area is short, and the first
 *  rows are the ones that show without a scroll. So Clear draft sits in the
 *  first row, next to the name, and not under the text. On a narrow chat the
 *  name stays on one line, so the row keeps the height of the button.
 *
 *  Only the sentence that says who wrote the draft is a live region. It does
 *  not change while the user types, so a screen reader announces it once. The
 *  counts change with each key, so they stay outside it. Warnings are alerts. */
export function WidgetDraftNotice({ source, origin = "tool-view", draft, onClear }: {
  source: string;
  origin?: WidgetDraftOrigin;
  draft: string;
  onClear: () => void;
}) {
  const report = useMemo(() => inspectDraft(draft), [draft]);
  const text = ORIGIN_TEXT[origin];
  return (
    <div
      role="group"
      aria-label={text.name}
      className="pointer-events-auto mx-auto mb-1.5 w-full max-w-3xl rounded-md border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs"
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium text-on-surface @max-md:truncate">
          {text.name}:{" "}
          {/* A tool view is named by its tool and resource, which are identifiers. */}
          <span className={origin === "tool-view" ? "break-words font-mono text-xs" : "break-words"}>{source}</span>
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onClear}>Clear draft</Button>
      </div>
      <p role="status" className="sr-only">
        {text.explanation} Review it before sending.
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 text-on-surface-variant">
        <span>Nothing is sent until you press Send.</span>
        <span className="tabular-nums">{report.characters.toLocaleString("en-US")} characters, {report.lines.toLocaleString("en-US")} {report.lines === 1 ? "line" : "lines"}.</span>
      </p>
      {report.warnings.length > 0 ? (
        <ul role="alert" className="mt-1 list-disc space-y-0.5 pl-5 text-danger">
          {report.warnings.map((warning) => <li key={warning}>{DRAFT_WARNING_TEXT[warning]}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
