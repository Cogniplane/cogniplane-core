"use client";

import { useCallback, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ModelSpendingPolicy, ModelSpendingResponse } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { refreshModelSpending } from "../../../hooks/use-model-spending";
import { ApiError } from "../../../lib/api-client";
import {
  budgetChangeConsequences,
  budgetStatus,
  budgetStatusCopy,
  draftFromPolicy,
  formatUsd,
  sameBudget,
  validateBudgetDraft,
  type BudgetDraft,
  type BudgetDraftValue,
  type LimitMode
} from "../../../lib/model-budget";
import { getModelSpending, updateModelSpendingPolicy } from "../../../lib/model-spending-api";
import { HINT } from "../../../lib/ui-tokens";

const MODES: Array<{ id: LimitMode; label: string; summary: string }> = [
  { id: "limit", label: "Set a monthly limit", summary: "New turns start while the limit has room for one more hold." },
  { id: "none", label: "No limit", summary: "New turns start without a hold. The budget ledger does not count them." },
  { id: "off", label: "Pause new turns", summary: "A limit of $0. No new chat or scheduled turn can start until you change it." }
];

function policyLine(policy: ModelSpendingPolicy): string {
  const limit = policy.monthlyLimitUsd === null ? "No limit" : policy.monthlyLimitUsd === 0 ? "New turns paused ($0 limit)" : `Limit ${formatUsd(policy.monthlyLimitUsd)}`;
  return `${limit}, hold per turn ${formatUsd(policy.turnReservationUsd)}`;
}

function draftLine(value: BudgetDraftValue): string {
  return policyLine({ ...value, version: 1 });
}

/**
 * The backend stores whole millionths of a USD and rounds up. For some typed
 * amounts, such as 4.03, it stores one millionth more. Say what it stored.
 */
function savedMessage(value: BudgetDraftValue, saved: ModelSpendingPolicy): string {
  const stored = `Budget saved. ${policyLine(saved)}. It applies to new turns.`;
  return sameBudget(value, saved) ? stored : `${stored} The server rounds up to a whole $0.000001, so a stored amount differs from what you entered.`;
}

function saveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return "The server did not accept these values. Check them and try again.";
  if (error instanceof ApiError && error.status === 403) return "Only administrators can change the budget.";
  return "Could not save the budget. Your changes are kept. Try again.";
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Edits the monthly limit and the hold per turn. The dialog keeps the policy
 * version it opened with. It never takes a newer version on its own: after a
 * conflict the administrator loads the current budget, compares it with the
 * draft, and saves again.
 */
export function BudgetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  month: string;
  /** The latest summary in the cache. Its policy can be newer than the one this dialog opened with. */
  summary: ModelSpendingResponse;
  /** False when the summary is from an earlier month or the last check failed. Its totals are then not current. */
  current: boolean;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const ids = useId();
  const [base, setBase] = useState<ModelSpendingPolicy>(props.summary.policy);
  const [draft, setDraft] = useState<BudgetDraft>(() => draftFromPolicy(props.summary.policy));
  const [touched, setTouched] = useState<{ limit?: boolean; reservation?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [conflict, setConflict] = useState<"none" | "conflict" | "reloaded">("none");

  const save = useMutation({
    mutationFn: (value: BudgetDraftValue) => updateModelSpendingPolicy({ ...value, version: base.version }),
    onSuccess: async (response, value) => {
      // Take the saved version first, so the refreshed cache does not look like someone else's change.
      setBase(response.policy);
      await refreshModelSpending(queryClient, props.month, { firstPage: response });
      props.onSaved(savedMessage(value, response.policy));
    },
    onError: (error) => {
      if (isConflict(error)) {
        setConflict("conflict");
        setStep("edit");
      }
    }
  });

  const reload = useMutation({
    mutationFn: () => getModelSpending(),
    onSuccess: async (fresh) => {
      setBase(fresh.policy);
      setConflict("reloaded");
      save.reset();
      await refreshModelSpending(queryClient, props.month, { firstPage: fresh });
    }
  });

  const pending = save.isPending || reload.isPending;
  // Move focus to the question when the confirm step opens. A stable callback
  // runs once per mount, so a re-render does not take focus from the buttons.
  const focusOnMount = useCallback((node: HTMLElement | null) => node?.focus(), []);
  // Another change landed after this dialog opened. Saving would fail, so ask for a reload first.
  const changedElsewhere = conflict === "conflict" || props.summary.policy.version !== base.version;
  const { errors, value } = validateBudgetDraft(draft);
  const unchanged = value !== null && sameBudget(value, base);
  // Without current totals, do not preview a status or count unknown usage.
  const consequences = value ? budgetChangeConsequences(value, base, props.current ? props.summary.unknownReservations : 0) : null;
  const preview = value && props.current ? budgetStatusCopy(budgetStatus({ ...props.summary, policy: { ...value, version: base.version } })) : null;
  const limitError = (touched.limit || submitted) && draft.mode === "limit" ? errors.limit : undefined;
  const reservationError = touched.reservation || submitted ? errors.reservation : undefined;

  const handleOpenChange = (open: boolean) => { if (!pending) props.onOpenChange(open); };
  const update = (patch: Partial<BudgetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (save.isError && !isConflict(save.error)) save.reset();
  };

  function submit() {
    setSubmitted(true);
    if (!value || unchanged || changedElsewhere || pending) return;
    if (consequences && step === "edit") {
      setStep("confirm");
      return;
    }
    save.mutate(value);
  }

  const confirmLabel = value?.monthlyLimitUsd === 0 ? "Pause new turns" : "Remove the limit";

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!pending}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        // A click outside must not throw away a draft.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          {step === "confirm" && consequences && value ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
              <DialogHeader className="pr-6">
                <DialogTitle tabIndex={-1} ref={focusOnMount} className="outline-none">
                  {value.monthlyLimitUsd === 0 ? "Pause new turns?" : "Remove the monthly limit?"}
                </DialogTitle>
                <DialogDescription>Read what changes before you confirm.</DialogDescription>
              </DialogHeader>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
                {consequences.map((line) => <li key={line}>{line}</li>)}
              </ul>
              {save.isError && !isConflict(save.error) ? <p role="alert" className="text-sm text-danger">{saveError(save.error)}</p> : null}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
              <DialogHeader className="pr-6">
                <DialogTitle>{base.monthlyLimitUsd === null ? "Set a monthly budget" : "Change the monthly budget"}</DialogTitle>
                <DialogDescription>Changes apply to new turns. Turns that are already running keep their holds.</DialogDescription>
              </DialogHeader>

              {changedElsewhere ? (
                <div role="alert" className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm text-on-surface">
                  <p>
                    <span className="font-semibold">Someone else changed the budget after you opened this dialog.</span>{" "}
                    Your draft is kept. Load the current budget and review it before you save.
                  </p>
                  {reload.isError ? <p className="text-danger">Could not load the current budget. Try again.</p> : null}
                  <Button type="button" size="sm" variant="outline" className="self-start" disabled={reload.isPending} aria-busy={reload.isPending} onClick={() => reload.mutate()}>
                    {reload.isPending ? "Loading…" : "Load current budget"}
                  </Button>
                </div>
              ) : null}
              {conflict === "reloaded" ? (
                <div role="status" className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-sm">
                  <p className="font-semibold text-on-surface">Compare before you save</p>
                  <dl className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-3">
                    <dt className="text-on-surface-variant">Saved now</dt>
                    <dd className="text-on-surface">{policyLine(base)}</dd>
                    <dt className="text-on-surface-variant">Your draft</dt>
                    <dd className="text-on-surface">{value ? draftLine(value) : "Not complete"}</dd>
                  </dl>
                  <Button type="button" size="sm" variant="ghost" className="-ml-2 self-start" onClick={() => { setDraft(draftFromPolicy(base)); setTouched({}); setSubmitted(false); }}>
                    Use the saved values
                  </Button>
                </div>
              ) : null}

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-semibold text-on-surface">Monthly limit</legend>
                {MODES.map((mode) => (
                  <label
                    key={mode.id}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-lg border border-outline-variant px-3 py-2.5 transition-colors hover:border-outline",
                      "has-[:checked]:border-brand has-[:checked]:bg-brand-surface has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
                    )}
                  >
                    <input
                      type="radio"
                      name={`${ids}-mode`}
                      value={mode.id}
                      checked={draft.mode === mode.id}
                      onChange={() => update({ mode: mode.id })}
                      className="mt-1 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-on-surface">{mode.label}</span>
                      <span className="mt-0.5 block text-sm text-on-surface-variant">{mode.summary}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {draft.mode === "limit" ? (
                <AmountField
                  id={`${ids}-limit`}
                  label="Limit per month (USD)"
                  hint="Estimated model cost for the UTC calendar month."
                  value={draft.limit}
                  error={limitError}
                  onChange={(limit) => update({ limit })}
                  onBlur={() => setTouched((current) => ({ ...current, limit: true }))}
                />
              ) : null}

              <AmountField
                id={`${ids}-reservation`}
                label="Hold per turn (USD)"
                hint={draft.mode === "none"
                  ? "Used only while a limit is set."
                  : "Each new turn holds this amount until it ends. Unused money returns then. A turn stops when its model calls use up the hold."}
                value={draft.reservation}
                error={reservationError}
                onChange={(reservation) => update({ reservation })}
                onBlur={() => setTouched((current) => ({ ...current, reservation: true }))}
              />

              {preview ? (
                <div className="rounded-lg bg-surface-container-low p-3 text-sm">
                  <p className="font-semibold text-on-surface">After you save: {preview.label.toLowerCase()}</p>
                  <p className="mt-1 text-on-surface-variant">{unchanged ? "This matches the saved budget." : preview.sentence}</p>
                </div>
              ) : null}
              {save.isError && !isConflict(save.error) ? <p role="alert" className="text-sm text-danger">{saveError(save.error)}</p> : null}
            </div>
          )}

          <DialogFooter className="border-t border-outline-variant px-6 py-4">
            {step === "confirm" ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => { save.reset(); setStep("edit"); }}>Back</Button>
            ) : (
              <Button type="button" variant="outline" disabled={pending} onClick={() => props.onOpenChange(false)}>Cancel</Button>
            )}
            <Button
              type="submit"
              variant={step === "confirm" && value?.monthlyLimitUsd === 0 ? "destructive" : "default"}
              disabled={pending || changedElsewhere || unchanged}
              aria-busy={save.isPending}
            >
              {save.isPending ? "Saving…" : step === "confirm" ? confirmLabel : save.isError && !isConflict(save.error) ? "Try again" : conflict === "reloaded" ? "Save my draft" : "Save budget"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AmountField(props: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-sm font-semibold text-on-surface">{props.label}</label>
      <div className="relative max-w-60">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-on-surface-variant">$</span>
        <Input
          id={props.id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="pl-7 tabular-nums"
          value={props.value}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => props.onChange(event.target.value)}
          onBlur={props.onBlur}
        />
      </div>
      {props.error ? <p id={errorId} className="text-sm text-danger">{props.error}</p> : null}
      <p id={hintId} className={HINT}>{props.hint}</p>
    </div>
  );
}
