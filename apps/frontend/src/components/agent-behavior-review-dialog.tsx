"use client";

import { useRef } from "react";
import { TriangleAlert } from "lucide-react";

import type { BehaviorChange, ImpactHighlight } from "./agent-behavior-impact";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { CHIP, PILL_AMBER, PILL_BLUE, PILL_GRAY, SECTION_LABEL } from "../lib/ui-tokens";

type Props = {
  open: boolean;
  changes: BehaviorChange[];
  highlights: ImpactHighlight[];
  showProjectNote: boolean;
  applying: boolean;
  /** Message of the last failed apply, or null. */
  failure: string | null;
  /** Newer organization settings version saved after this draft started, or null. */
  conflictVersion: number | null;
  toolLabel: (id: string) => string;
  onBack: () => void;
  onApply: () => void;
  onRebase: () => void;
  onDiscard: () => void;
  /** Move focus back to the page after the dialog closes. */
  onRestoreFocus: () => void;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function TonePill({ change }: { change: BehaviorChange }) {
  if (change.savedOnly) return <span className={PILL_GRAY}>Not used by the runtime</span>;
  if (change.tone === "widens") return <span className={PILL_AMBER}>Widens access</span>;
  if (change.tone === "narrows") return <span className={PILL_BLUE}>Adds limits</span>;
  return null;
}

function ValueTerm({ children }: { children: string }) {
  return (
    <dt className="pt-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-on-surface-faint">
      {children}
    </dt>
  );
}

function TextValue({ text }: { text: string }) {
  if (!text) return <span className="text-sm italic text-on-surface-variant">None</span>;
  return (
    <p className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md border border-outline-variant bg-surface-container-low px-3 py-2 text-xs leading-relaxed text-on-surface [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}

function ChipList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className={`${CHIP} [overflow-wrap:anywhere]`}>{item}</li>
      ))}
    </ul>
  );
}

function ChangeValues({ change, toolLabel }: { change: BehaviorChange; toolLabel: (id: string) => string }) {
  const grid = "grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-sm";
  if (change.display === "set") {
    const label = change.field === "enabledToolIds" ? toolLabel : (value: string) => value;
    return (
      <dl className={grid}>
        {change.added.length > 0 ? (
          <>
            <ValueTerm>Added</ValueTerm>
            <dd><ChipList items={change.added.map(label)} /></dd>
          </>
        ) : null}
        {change.removed.length > 0 ? (
          <>
            <ValueTerm>Removed</ValueTerm>
            <dd><ChipList items={change.removed.map(label)} /></dd>
          </>
        ) : null}
      </dl>
    );
  }
  if (change.display === "text") {
    return (
      <dl className={grid}>
        <ValueTerm>Before</ValueTerm>
        <dd className="min-w-0"><TextValue text={change.before} /></dd>
        <ValueTerm>After</ValueTerm>
        <dd className="min-w-0"><TextValue text={change.after} /></dd>
      </dl>
    );
  }
  return (
    <dl className={grid}>
      <ValueTerm>Before</ValueTerm>
      <dd className="text-on-surface-variant [overflow-wrap:anywhere]">{change.before}</dd>
      <ValueTerm>After</ValueTerm>
      <dd className="font-medium text-on-surface [overflow-wrap:anywhere]">{change.after}</dd>
    </dl>
  );
}

export function AgentBehaviorReviewDialog(props: Props) {
  const { changes, applying, failure, conflictVersion } = props;
  const backRef = useRef<HTMLButtonElement>(null);
  const widening = changes.filter((change) => change.tone === "widens").length;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !applying) props.onBack();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Focus the safe action first, as an alert dialog does.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          backRef.current?.focus();
        }}
        // The dialog has no Radix trigger, so the page selects the focus target.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onRestoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (applying) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (applying) event.preventDefault();
        }}
        className="flex max-h-[min(90dvh,52rem)] flex-col gap-0 overflow-hidden border-outline-variant bg-surface p-0 text-on-surface sm:max-w-2xl"
      >
        <DialogHeader className="gap-1.5 border-b border-outline-variant px-5 py-4 text-left sm:px-6">
          <p className={SECTION_LABEL}>Agent behavior · organization defaults</p>
          <DialogTitle className="text-lg leading-snug text-on-surface">
            {changes.length === 0 ? "No changes to apply" : `Review ${plural(changes.length, "change")}`}
          </DialogTitle>
          <DialogDescription className="text-sm text-on-surface-variant">
            Changes that the runtime uses apply to every member&apos;s agents from each
            session&apos;s next turn. Turns that run now finish with the current settings.
          </DialogDescription>
          {widening > 0 ? (
            <p className="text-xs font-medium text-warning">
              {widening === changes.length && changes.length === 1
                ? "This change widens what agents can do."
                : `${plural(widening, "change")} widen what agents can do.`}
            </p>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          {conflictVersion !== null ? (
            <div role="alert" className="mb-4 rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm">
              <p className="font-semibold text-warning">
                Organization settings changed (v{conflictVersion}) since your draft began.
              </p>
              <p className="mt-1 text-on-surface">
                A change on this page or on another admin page, or a save that could not be
                confirmed, can cause this. Your draft is kept. Put your edits on the latest
                settings and review them again, or discard your edits.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={props.onRebase}>
                  Review my edits on v{conflictVersion}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={props.onDiscard}>
                  Discard my edits
                </Button>
              </div>
            </div>
          ) : null}

          {props.highlights.map((highlight) => (
            <div
              key={highlight.id}
              role="note"
              className="mb-4 flex gap-3 rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="font-semibold text-on-surface">{highlight.title}</p>
                <p className="mt-0.5 text-on-surface-variant">{highlight.detail}</p>
              </div>
            </div>
          ))}

          {changes.length === 0 ? (
            <p className="text-sm text-on-surface-variant">
              Your draft matches the saved settings. Go back to editing to make a change.
            </p>
          ) : (
            <ol aria-label="Changed settings" className="flex flex-col divide-y divide-outline-variant">
              {changes.map((change) => (
                <li
                  key={change.field}
                  className={`flex flex-col gap-2.5 py-4 first:pt-0 last:pb-0 ${
                    change.tone === "widens" ? "border-l-2 border-l-warning pl-3" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-sm font-semibold text-on-surface">{change.label}</h3>
                    <TonePill change={change} />
                  </div>
                  <ChangeValues change={change} toolLabel={props.toolLabel} />
                  <p className="text-sm text-on-surface">{change.effect}</p>
                  {change.note ? <p className="text-xs text-on-surface-variant">{change.note}</p> : null}
                </li>
              ))}
            </ol>
          )}

          {props.showProjectNote ? (
            <p className="mt-4 rounded-md bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
              Projects that follow organization defaults use these approval settings. Projects set
              to manual approval keep asking before tools, whatever you choose here.
            </p>
          ) : null}
        </div>

        {failure !== null && conflictVersion === null ? (
          <div role="alert" className="border-t border-danger/30 bg-danger-surface px-5 py-3 text-sm sm:px-6">
            <p className="font-semibold text-danger">Could not confirm the save.</p>
            <p className="mt-0.5 text-on-surface [overflow-wrap:anywhere]">
              {failure} The settings can be saved even when this error shows. Your draft is kept.
              The page gets the saved settings again. If they changed, you can review your edits
              on them.
            </p>
          </div>
        ) : null}

        <DialogFooter className="border-t border-outline-variant px-5 py-3 sm:px-6">
          <Button ref={backRef} type="button" variant="outline" disabled={applying} onClick={props.onBack}>
            Back to editing
          </Button>
          <Button
            type="button"
            disabled={applying || changes.length === 0 || conflictVersion !== null}
            onClick={props.onApply}
          >
            {applying
              ? "Applying…"
              : failure !== null
                ? "Try again"
                : changes.length === 0
                  ? "Apply changes"
                  : `Apply ${plural(changes.length, "change")}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
