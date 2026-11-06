"use client";
// Shows beside the message box what the next message sends from generated
// views: the values that the user entered, view by view, and the views that a
// limit or the organization policy leaves out.
//
// It reads the user-owned values from the SDK surface manager, the same
// source as the envelope of a run, and gives them to the browser agent's
// preview, which runs the request's own code for the earlier records. So the
// list shows the values as the request sends them, a cut text included. It
// keeps nothing: no storage, no request, no log.
//
// The manager has no event for a user edit, so the list reads again shortly
// after an input in generated UI, as the draft store does, and after the draft
// store puts values back (`restored`).

import { useGenerativeUIRuntime } from "@copilotkit/react-core/v2/generative-ui";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { MAX_EARLIER_VALUE_CHARS } from "../lib/agui/deep-agents-browser-agent";
import { fromGeneratedUi, GENERATED_UI_EDIT_EVENTS } from "./generative-ui-drafts";
import { inputContextOf, inputContextSummary, NO_INPUT_CONTEXT, type InputContext } from "./generative-ui-input-context.logic";

/** Milliseconds between an input in generated UI and the next read. */
const READ_DELAY_MS = 120;

export function useGenerativeUiInputContext(agent: DeepAgentsBrowserAgent, restored: number): InputContext {
  const manager = useGenerativeUIRuntime()?.manager;
  const [context, setContext] = useState<InputContext>(NO_INPUT_CONTEXT);
  const readRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const threadId = agent.threadId;
    if (!manager || !threadId) return;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const next = inputContextOf(agent.previewEarlierRecords(manager.describeSurfaces(threadId)));
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      setContext(next);
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(read, READ_DELAY_MS);
    };
    const onEdit = (event: Event) => { if (fromGeneratedUi(event)) later(); };
    const unsubscribeManager = manager.subscribe(later);
    // A refused message can withhold records. A new turn adds surfaces.
    const subscription = agent.subscribe({ onMessagesChanged: later, onRunFailed: later, onRunFinalized: later });
    for (const name of GENERATED_UI_EDIT_EVENTS) document.addEventListener(name, onEdit, true);
    readRef.current = later;
    read();
    return () => {
      readRef.current = null;
      clearTimeout(timer);
      for (const name of GENERATED_UI_EDIT_EVENTS) document.removeEventListener(name, onEdit, true);
      subscription.unsubscribe();
      unsubscribeManager();
    };
  }, [agent, manager]);

  useEffect(() => {
    if (restored > 0) readRef.current?.();
  }, [restored]);

  return context;
}

/** The compact line above the message box, and the list behind it. The list
 *  has no scroll of its own. The composer's scroll region scrolls it. The
 *  summary scrolls with the list, because in a short chat area the region is
 *  too small to hold a fixed summary and still show entries.
 *
 *  On a narrow chat the summary is one row: the sentence is cut with an
 *  ellipsis, and "Review" keeps its place at the end. The row is then short
 *  enough to show above the draft notice without a scroll. The opened list
 *  says again that the agent reads the values with the next message. */
export function GenerativeUiInputContext({ context }: { context: InputContext }) {
  const summary = inputContextSummary(context);
  if (summary === "") return null;
  return (
    <details className="group pointer-events-auto mx-auto mb-1.5 w-full max-w-3xl rounded-md border border-outline-variant bg-surface-container-low text-xs text-on-surface-variant">
      <summary className="flex cursor-pointer list-none items-start gap-1.5 rounded-md px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        <span className="min-w-0 flex-1 @max-md:flex @max-md:items-baseline @max-md:gap-1.5">
          <span className="text-on-surface @max-md:truncate">{summary}.</span> <span className="underline underline-offset-2 @max-md:shrink-0">Review</span>
        </span>
      </summary>
      <div className="border-t border-outline-variant px-3 py-2">
        <p className="m-0">
          The agent reads these values with your next message. Only values that you changed are listed.
        </p>
        {context.views.map((view) => (
          <section key={view.key} aria-label={view.name} className="mt-2">
            <h4 className="m-0 text-xs font-semibold text-on-surface">{view.name}</h4>
            <dl className="m-0 mt-1 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {view.rows.map((row, index) => (
                <div key={index} className="contents">
                  <dt className="break-words">{row.label}</dt>
                  <dd className="m-0 whitespace-pre-wrap break-words text-on-surface">
                    {row.value === null ? <span className="text-on-surface-variant">Too large to send. Not sent.</span> : row.value}
                    {row.cut ? (
                      <span className="block text-on-surface-variant">
                        Only the first {MAX_EARLIER_VALUE_CHARS.toLocaleString("en-US")} characters are sent.
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {context.tooLarge > 0 ? (
          <p className="m-0 mt-2">
            {context.tooLarge} {context.tooLarge === 1 ? "view is" : "views are"} left out to stay within the size limit. The newest views are sent first.
          </p>
        ) : null}
        {context.blocked > 0 ? (
          <p className="m-0 mt-2 text-danger">
            {context.blocked} {context.blocked === 1 ? "view is" : "views are"} left out because organization policy blocked
            {context.blocked === 1 ? " its" : " their"} values. Change the values to send them again.
          </p>
        ) : null}
      </div>
    </details>
  );
}
