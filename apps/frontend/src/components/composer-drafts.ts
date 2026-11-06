"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { CogniplaneCustomEventSchema } from "@cogniplane/shared-types";
import type { AbstractAgent } from "@ag-ui/client";
import { httpFailure, isReconnectRun } from "../lib/agui/deep-agents-browser-agent";
import type { DraftScope } from "./generative-ui-drafts.logic";
import type { WidgetDraftComposer } from "./widget-draft";
import {
  composerClearEpoch, loadComposerDraft, saveComposerDraft,
  type ComposerDraft, type ComposerPersistence
} from "./composer-drafts.logic";

/** The host keys this hook by person, tenant and session. Its value controls
 *  the SDK input. CopilotChat's eager clear and failed-send restoration cannot
 *  overwrite it. Only a persisted prompt confirms a send. */
export function useComposerDraft(agent: AbstractAgent, scope: DraftScope | undefined, widget: WidgetDraftComposer) {
  const [initial] = useState(() => loadComposerDraft(scope, agent.threadId));
  const [value, setValue] = useState(initial.text);
  const [uncertain, setUncertain] = useState(initial.pending === true);
  const [persistence, setPersistence] = useState<ComposerPersistence>("ok");
  const current = useRef<ComposerDraft>(initial);
  const revision = useRef(0);
  const epoch = useRef(composerClearEpoch());
  const sending = useRef<{ revision: number; runId?: string } | null>(null);
  const live = useCallback(() => epoch.current === composerClearEpoch(), []);
  const userId = scope?.userId;
  const tenantId = scope?.tenantId;
  const persist = useCallback(() => {
    if (live()) setPersistence(saveComposerDraft(userId && tenantId ? { userId, tenantId } : undefined, agent.threadId, current.current));
  }, [agent, live, userId, tenantId]);
  const change = useCallback((text: string) => {
    revision.current++;
    current.current = { text, written: text.trim() ? current.current.written : null };
    setUncertain(false);
    setValue(text);
    persist();
  }, [persist]);
  const beginSend = useCallback(() => {
    sending.current = { revision: revision.current };
    current.current = { ...current.current, pending: true };
    setUncertain(false);
    persist();
  }, [persist]);
  const cancelUnstartedSend = useCallback(() => {
    if (!live() || !sending.current || sending.current.runId) return;
    sending.current = null;
    const { pending: _pending, ...draft } = current.current;
    current.current = draft;
    persist();
  }, [live, persist]);
  const { restore, end, source, origin } = widget;
  const previousWritten = useRef({ source, origin });
  useLayoutEffect(() => { restore(initial.written); }, [initial, restore]);
  useLayoutEffect(() => {
    const previous = previousWritten.current;
    previousWritten.current = { source, origin };
    if (previous.source === source && previous.origin === origin) return;
    const written = current.current.written;
    if ((written?.source ?? null) === source && (written?.origin ?? "tool-view") === origin) return;
    current.current = { ...current.current, written: source ? { source, origin } : null };
    persist();
  }, [origin, persist, source]);

  useLayoutEffect(() => {
    let disposed = false;
    const confirm = () => {
      if (disposed || !live()) return;
      const attempt = sending.current;
      const pending = current.current.pending;
      if (!pending && !attempt) return;
      sending.current = null;
      setUncertain(false);
      // The user can type the same words again. The revision, not text
      // equality, decides whether this is still the submitted draft.
      if (attempt ? attempt.revision === revision.current : !!pending) {
        current.current = { text: "", written: null };
        setValue("");
        end();
      } else {
        const { pending: _pending, ...draft } = current.current;
        current.current = draft;
      }
      persist();
    };
    const subscription = agent.subscribe({
      onRunInitialized({ input }) {
        if (disposed || !live()) return;
        if (!isReconnectRun(input) && sending.current) sending.current.runId ??= input.runId;
      },
      onCustomEvent({ event, input }) {
        if (disposed || !live()) return;
        const parsed = CogniplaneCustomEventSchema.safeParse(event);
        if (!parsed.success || parsed.data.name !== "user_message_persisted") return;
        const ownSend = !isReconnectRun(input) && sending.current?.runId === input.runId;
        if (ownSend) confirm();
      },
      onRunFailed({ error, input }) {
        if (disposed || !live()) return;
        // A client rejection proves that this attempt was not admitted. Keep
        // the text, but do not mistake a later identical prompt for this send.
        const failure = httpFailure(error);
        if (isReconnectRun(input) || sending.current?.runId !== input.runId) return;
        sending.current = null;
        if (failure && failure.status < 500) {
          const { pending: _pending, ...draft } = current.current;
          current.current = draft;
          setUncertain(false);
          persist();
        } else if (current.current.pending) {
          setUncertain(true);
        }
      },
      onRunFinalized({ input }) {
        if (disposed || !live() || isReconnectRun(input) || sending.current?.runId !== input.runId) return;
        sending.current = null;
        // A clean stream close does not confirm that the message was saved.
        if (current.current.pending) setUncertain(true);
      }
    });
    return () => { disposed = true; subscription.unsubscribe(); };
  }, [agent, end, live, persist]);
  return { value, change, beginSend, cancelUnstartedSend, persistence, uncertain };
}
