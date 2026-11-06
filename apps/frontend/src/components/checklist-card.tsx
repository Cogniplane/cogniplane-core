"use client";
// Checklist: an application component of the chat's generative UI catalog.
//
// The model sets the items, the title, and the start values. The user ticks
// items and writes notes. `checked` and `notes` are writable props: when the
// model binds them to a data model path, the SDK setter writes the user's
// value there and marks the path user-owned. The draft store then keeps it
// through a reload (generative-ui-drafts.ts), and the next message sends it
// to the model as an earlier record (DeepAgentsBrowserAgent).
//
// A literal `checked` or `notes` gets a local value from the SDK setter: it
// is not kept and it is not sent. The component cannot see whether a prop is
// bound, so it checks each write. When the user values of the surface manager
// did not change, the write did not reach a data model. The component then
// puts the shown value back, and the checklist becomes read-only with a note.
//
// "Use in reply" is app UI, not a model event. It puts a text of the current
// values in the message box through the draft seam of the chat (widget-draft).
// It never sends, starts a run, fetches, or opens a link. The user reads the
// text, can change it, and sends it with the normal Send button. A draft of
// the user stays: the button asks before it adds the text after it.

import { CHECKLIST_LIMITS } from "@cogniplane/shared-types";
import { useGenerativeUIRuntime } from "@copilotkit/react-core/v2/generative-ui";
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  checkedCount,
  checklistReplyText,
  checklistSourceLabel,
  cleanLine,
  completeChecked,
  progressLabel,
  type ChecklistItem
} from "./checklist-card.logic";
import type { WidgetDraftPlacement, WidgetDraftRequest } from "./widget-draft";

/** Whether the message box of the chat can take a draft now. */
export type ChecklistReplyState = "ready" | "loading" | "busy" | "read-only";

type ChecklistHost = {
  /** The thread of the surfaces: the session id. */
  threadId: string;
  replyState: ChecklistReplyState;
  place: (request: WidgetDraftRequest) => WidgetDraftPlacement;
};

const ChecklistHostContext = createContext<ChecklistHost | null>(null);

/** Gives the checklists of one chat its message box and its state. */
export function ChecklistHostProvider({ value, children }: { value: ChecklistHost; children: ReactNode }) {
  return <ChecklistHostContext.Provider value={value}>{children}</ChecklistHostContext.Provider>;
}

type ChecklistComponentProps = {
  title?: string;
  items: ChecklistItem[];
  checked?: Record<string, boolean>;
  notes?: string;
  setChecked: (value: Record<string, boolean>) => void;
  setNotes: (value: string) => void;
};

/** The result of the last "Use in reply", shown under the button. */
type ReplyResult = "placed" | "occupied" | "unavailable" | null;

const WAIT_TEXT: Record<Exclude<ChecklistReplyState, "ready">, string> = {
  loading: "You can use this in a reply when the chat has loaded.",
  busy: "You can use this in a reply when the agent finishes.",
  "read-only": "Only project owners and editors can send messages in this chat."
};

/**
 * Runs a setter and tells whether it changed the user-owned values of the
 * surface manager. A bound prop writes there. A literal prop, a deleted
 * surface, or a path that does not fit the data writes nothing there.
 */
function useOwnedWrite(threadId: string | undefined) {
  const manager = useGenerativeUIRuntime()?.manager;
  return useCallback((write: () => void): boolean => {
    const thread = threadId ?? manager?.getActiveThread();
    if (!manager || !thread) {
      write();
      return false;
    }
    const before = JSON.stringify(manager.describeSurfaces(thread));
    write();
    return JSON.stringify(manager.describeSurfaces(thread)) !== before;
  }, [manager, threadId]);
}

export function GenerativeChecklist({ title, items, checked, notes, setChecked, setNotes }: ChecklistComponentProps) {
  const host = useContext(ChecklistHostContext);
  const ownedWrite = useOwnedWrite(host?.threadId);
  const [locked, setLocked] = useState(false);
  const [result, setResult] = useState<ReplyResult>(null);
  const headingId = useId();
  const notesId = useId();
  const notesHintId = useId();
  const itemsId = useId();

  const values = completeChecked(items, checked);
  const done = checkedCount(values);
  const heading = title ? cleanLine(title) : "Checklist";

  const write = (apply: () => void, undo: () => void) => {
    setResult(null);
    if (locked) return;
    if (ownedWrite(apply)) return;
    // The value stayed in this node only. Show the value that is kept.
    undo();
    setLocked(true);
  };
  const toggle = (id: string, next: boolean) => {
    const previous = values;
    write(() => setChecked({ ...values, [id]: next }), () => setChecked(previous));
  };
  const changeNotes = (next: string) => {
    const previous = notes ?? "";
    write(() => setNotes(next), () => setNotes(previous));
  };

  const useInReply = (append: boolean) => {
    if (!host) return;
    setResult(host.place({
      text: checklistReplyText({ title, items, checked: values, notes }),
      source: checklistSourceLabel(title),
      origin: "generated-view",
      append
    }));
  };

  return (
    <section
      aria-labelledby={headingId}
      // The chat card or the side panel frames the surface, so the checklist
      // draws no card of its own.
      className="my-1 w-full max-w-xl text-sm text-on-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="m-0 min-w-0 text-sm! font-semibold [overflow-wrap:anywhere]">{heading}</h3>
        <p className="m-0 text-xs tabular-nums text-on-surface-variant">{progressLabel(done, items.length)}</p>
      </div>
      <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-surface-container">
        <div className="h-full rounded-full bg-brand" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>

      <ul className="m-0 mt-2 list-none divide-y divide-outline-variant p-0">
        {items.map((item) => (
          <li key={item.id}>
            <label className={`flex items-start gap-3 py-2 ${locked ? "cursor-default" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default"
                aria-labelledby={`${itemsId}-${item.id}-label`}
                aria-describedby={item.description ? `${itemsId}-${item.id}-description` : undefined}
                checked={values[item.id]}
                disabled={locked}
                onChange={(event) => toggle(item.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1 break-words">
                <span id={`${itemsId}-${item.id}-label`} className="block leading-snug">{cleanLine(item.label)}</span>
                {item.description ? (
                  <span id={`${itemsId}-${item.id}-description`} className="mt-0.5 block text-xs leading-snug text-on-surface-variant">{cleanLine(item.description)}</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {notes !== undefined ? (
        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
          <label htmlFor={notesId} className="pt-2 text-xs font-medium text-on-surface">Notes</label>
          <Textarea
            id={notesId}
            value={notes}
            rows={3}
            maxLength={CHECKLIST_LIMITS.notesChars}
            readOnly={locked}
            aria-describedby={notesHintId}
            className="max-h-48 bg-surface-container-lowest"
            onChange={(event) => changeNotes(event.target.value)}
          />
          <p id={notesHintId} className="col-start-2 m-0 text-right text-xs tabular-nums text-on-surface-variant">
            {notes.length.toLocaleString("en-US")} / {CHECKLIST_LIMITS.notesChars.toLocaleString("en-US")} characters
          </p>
        </div>
      ) : null}

      {locked ? (
        <p role="note" className="m-0 mt-2 rounded-md bg-warning-surface px-3 py-2 text-xs text-warning">
          This checklist cannot keep changes, so it is read-only. Changes here would not be saved or sent to the agent.
          Ask the agent to make the checklist again.
        </p>
      ) : null}

      {host ? <ReplyControls state={host.replyState} result={result} onUse={useInReply} /> : null}
    </section>
  );
}

function ReplyControls({ state, result, onUse }: {
  state: ChecklistReplyState;
  result: ReplyResult;
  onUse: (append: boolean) => void;
}) {
  if (state === "read-only") {
    return <p className="m-0 mt-3 text-xs text-on-surface-variant">{WAIT_TEXT["read-only"]}</p>;
  }
  const ready = state === "ready";
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-outline-variant pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => onUse(false)}>
          Use in reply
        </Button>
        <p className="m-0 min-w-0 flex-1 text-xs text-on-surface-variant">
          {ready ? "Puts these values in the message box. Nothing is sent until you press Send." : WAIT_TEXT[state]}
        </p>
      </div>
      <div role="status" className="text-xs empty:hidden">
        {result === "placed" ? (
          <p className="m-0 text-on-surface">Added to the message box. Read it, then press Send.</p>
        ) : null}
        {result === "occupied" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="m-0 text-on-surface">The message box has your text. Nothing changed.</p>
            <Button type="button" size="xs" variant="outline" disabled={!ready} onClick={() => onUse(true)}>
              Add after my text
            </Button>
          </div>
        ) : null}
        {result === "unavailable" ? (
          <p className="m-0 text-danger">
            The message box cannot take text now. Try again when the agent finishes and the message box shows.
          </p>
        ) : null}
      </div>
    </div>
  );
}
