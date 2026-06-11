"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { EffortLevel, Model, RuntimeProvider } from "@cogniplane/shared-types";
import { ProviderModelSelector } from "./provider-model-selector";
import { ContextWindowMeter } from "./context-window-meter";
import {
  canSubmitDraft,
  canSubmitDraftViaKeyboard,
  providerLabel,
  shouldConfirmProviderChange
} from "./composer.logic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

export function Composer(props: {
  selectedSessionId: string | null;
  isSending: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  provider: RuntimeProvider;
  enabledProviders: RuntimeProvider[];
  model: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector: boolean;
  hasConversationHistory: boolean;
  contextTokens: number;
  contextWindow: number;
  onProviderChange: (provider: RuntimeProvider) => void;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pendingProviderChange, setPendingProviderChange] = useState<RuntimeProvider | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!pendingProviderChange) return;
    if (pendingProviderChange === props.provider) {
      // Dismiss the dialog once the parent confirms the provider switch via props.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingProviderChange(null);
    }
  }, [pendingProviderChange, props.provider]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitDraft(props.selectedSessionId, draft)) return;
    props.onSend(draft.trim());
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!canSubmitDraftViaKeyboard(props.selectedSessionId, props.isSending, draft)) return;
      props.onSend(draft.trim());
      setDraft("");
    }
  }

  function handleProviderChange(nextProvider: RuntimeProvider) {
    if (
      shouldConfirmProviderChange(
        props.provider,
        nextProvider,
        props.selectedSessionId,
        props.hasConversationHistory
      )
    ) {
      setPendingProviderChange(nextProvider);
      return;
    }
    if (nextProvider === props.provider) return;
    props.onProviderChange(nextProvider);
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="mx-auto mb-5 mt-4 flex w-[min(860px,calc(100%-48px))] flex-col gap-1 rounded-xl border border-outline-variant bg-surface-bright px-4 py-2.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-primary-mid focus-within:shadow-[0_0_0_3px_rgba(61,90,153,0.18),0_2px_8px_rgba(42,52,57,0.06)] dark:bg-surface-container-lowest"
      >
        <textarea
          ref={textareaRef}
          aria-label="Message composer"
          disabled={!props.selectedSessionId || props.isSending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question or describe the task you want the runtime to perform."
          value={draft}
          className="max-h-[220px] min-h-[28px] w-full resize-none border-0 bg-transparent px-1 py-2 text-[0.95rem] leading-snug text-on-surface outline-none placeholder:text-on-surface-faint"
        />
        <div className="flex items-center justify-between gap-3 px-1 py-0.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {props.error ? (
              <p className="text-sm text-danger">{props.error}</p>
            ) : (
              <>
                <ProviderModelSelector
                  provider={props.provider}
                  enabledProviders={props.enabledProviders}
                  model={props.model}
                  effort={props.effort}
                  models={props.models}
                  showEffortSelector={props.showEffortSelector}
                  disabled={!props.selectedSessionId || props.isSending}
                  onProviderChange={handleProviderChange}
                  onModelChange={props.onModelChange}
                  onEffortChange={props.onEffortChange}
                />
                <ContextWindowMeter
                  usedTokens={props.contextTokens}
                  contextWindow={props.contextWindow}
                />
              </>
            )}
          </div>
          {props.isSending ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={props.onStop}
              aria-label="Stop generating"
            >
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmitDraft(props.selectedSessionId, draft)}
            >
              Send
              <kbd
                aria-hidden="true"
                className="ml-0.5 inline-flex items-center rounded-sm bg-[color-mix(in_srgb,currentColor_18%,transparent)] px-1 py-px font-mono text-[0.7rem] leading-none opacity-85"
              >
                ↵
              </kbd>
            </Button>
          )}
        </div>
      </form>

      <Dialog
        open={pendingProviderChange != null}
        onOpenChange={(open) => {
          if (!open) setPendingProviderChange(null);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              Switch to {pendingProviderChange ? providerLabel(pendingProviderChange) : "?"}?
            </DialogTitle>
            <DialogDescription>
              Changing providers mid-conversation can drop some hidden reasoning trace and runtime-specific
              context. The visible chat history stays, but the new provider may miss details from earlier
              internal thinking. If the details matter, restate the key constraints after switching.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingProviderChange(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingProviderChange) props.onProviderChange(pendingProviderChange);
                setPendingProviderChange(null);
              }}
            >
              Switch provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
