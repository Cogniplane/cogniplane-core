"use client";
// How a tool view puts a draft in the chat message box.
//
// CopilotChat owns the text of its message box and passes it to the composer
// slot as `value` and `onChange`. The composer slot binds those two props here,
// so a tool view reaches the box through a supported seam and no CopilotKit
// internals. The text goes in as a draft only. The user sends it with the
// normal Send button, which sends the text that the box holds at that time.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "./ui/button";
import {
  DRAFT_WARNING_TEXT,
  appendToDraft,
  inspectDraft
} from "./widget-draft.logic";

type ComposerBinding = { value: string; setValue: (value: string) => void };

export type WidgetDraftRequest = {
  text: string;
  /** Names the tool view in the notice. */
  source: string;
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
  /** The tool view that wrote the draft, while the notice shows. */
  source: string | null;
  /** The draft is gone or sent. The notice goes away. */
  end: () => void;
};

export function useWidgetDraft(canPlace: boolean): { seam: WidgetDraftSeam; composer: WidgetDraftComposer } {
  const bindingRef = useRef<ComposerBinding | null>(null);
  const canPlaceRef = useRef(canPlace);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
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
    setSource(request.source);
    return "placed";
  }, []);
  const bind = useCallback((binding: ComposerBinding | null) => {
    bindingRef.current = binding;
  }, []);
  const end = useCallback(() => setSource(null), []);

  const seam = useMemo(() => ({ place }), [place]);
  const composer = useMemo(() => ({ bind, source, end }), [bind, source, end]);
  return { seam, composer };
}

/** Shows near the message box while it holds text from a tool view. It
 *  reads the draft as it is now, so it follows the edits of the user. */
export function WidgetDraftNotice({ source, draft, onClear }: {
  source: string;
  draft: string;
  onClear: () => void;
}) {
  const report = useMemo(() => inspectDraft(draft), [draft]);
  return (
    <div
      role="status"
      aria-label="Draft from a tool view"
      className="mx-auto mb-2 w-full max-w-3xl rounded-md border border-outline-variant bg-surface-container-low px-3 py-2 text-sm"
    >
      <p className="font-medium text-on-surface">
        Draft from a tool view: <span className="break-words font-mono text-xs">{source}</span>
      </p>
      <p className="mt-1 text-on-surface-variant">
        A tool view wrote this text. You did not. Nothing is sent until you press Send. Read the text, and change it if needed.
        {" "}
        <span>{report.characters.toLocaleString("en-US")} characters, {report.lines.toLocaleString("en-US")} {report.lines === 1 ? "line" : "lines"}.</span>
      </p>
      {report.warnings.length > 0 ? (
        <ul role="alert" className="mt-1 list-disc space-y-0.5 pl-5 text-danger">
          {report.warnings.map((warning) => <li key={warning}>{DRAFT_WARNING_TEXT[warning]}</li>)}
        </ul>
      ) : null}
      <div className="mt-2">
        <Button type="button" size="sm" variant="outline" onClick={onClear}>Clear draft</Button>
      </div>
    </div>
  );
}
