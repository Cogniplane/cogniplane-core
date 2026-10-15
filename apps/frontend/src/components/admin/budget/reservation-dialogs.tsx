"use client";

import { useId, useState } from "react";
import type { ModelSpendingReservation } from "@cogniplane/shared-types";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMicroUsd, formatMonth, parseVerifiedCost } from "../../../lib/model-budget";
import { HINT } from "../../../lib/ui-tokens";

type ActionState = {
  pending: boolean;
  /** Shown in the dialog. Null when there is no error. */
  error: string | null;
  /**
   * Set when the server said that the reservation changed. This action must
   * not repeat. The value is the state of the list reload.
   */
  stale: "pending" | "done" | "failed" | null;
};

type DialogProps = ActionState & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  reservation: ModelSpendingReservation;
};

function ReservationId({ reservation }: { reservation: ModelSpendingReservation }) {
  return (
    <span className="block font-mono text-xs text-on-surface-variant wrap-anywhere">
      Reservation {reservation.reservationId} · session {reservation.sessionId}
    </span>
  );
}

const STALE_REFRESH: Record<"pending" | "done" | "failed", string> = {
  pending: "Loading the list again…",
  done: "The list is now current. Review it before you act.",
  failed: "Could not load the list again. Close this dialog, retry the budget check, and review the list before you act."
};

function StaleNotice({ refresh }: { refresh: "pending" | "done" | "failed" }) {
  return (
    <p role="alert" className="rounded-lg bg-warning-surface p-3 text-sm text-on-surface">
      This reservation changed after the list loaded. {STALE_REFRESH[refresh]}
    </p>
  );
}

/**
 * Closing keeps the charge, stops new model calls under the reservation and
 * marks its usage unknown. It does not stop requests already sent.
 */
export function CloseReservationDialog(props: DialogProps & {
  /** The reservation is in the current month and a limit above zero applies. */
  blocksNewTurns: boolean;
  currentMonth: string;
  onConfirm: () => void;
}) {
  const { reservation } = props;
  const olderMonth = reservation.period !== props.currentMonth;
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!props.pending) props.onOpenChange(open); }}>
      <AlertDialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (props.pending) event.preventDefault(); }}
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Close this reservation?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div><ReservationId reservation={reservation} /></div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
            <li>No new model call can start under this reservation.</li>
            <li>Requests already sent to a provider keep running. Closing does not cancel them.</li>
            <li>The held charge of {formatMicroUsd(reservation.chargedMicroUsd)} stays in the ledger. Closing does not refund it.</li>
            <li>Its usage becomes unknown. Then you reconcile it with the verified cost.</li>
            {olderMonth ? (
              <li>It belongs to {formatMonth(reservation.period)}, so it does not block new turns this month.</li>
            ) : props.blocksNewTurns ? (
              <li className="font-medium text-warning">No new turn can start this month until you reconcile it.</li>
            ) : null}
          </ul>
          {props.stale ? <StaleNotice refresh={props.stale} /> : props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={props.pending} onClick={() => props.onOpenChange(false)}>
            {props.stale ? "Back to the list" : "Keep open"}
          </Button>
          {props.stale ? null : (
            <Button variant="destructive" disabled={props.pending} aria-busy={props.pending} onClick={props.onConfirm}>
              {props.pending ? "Closing…" : props.error ? "Try again" : "Close reservation"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Reconciliation replaces the held charge with a verified total. The amount
 * starts empty: a missing usage record is not evidence of a zero cost.
 */
export function ReconcileReservationDialog(props: DialogProps & { onConfirm: (actualUsd: number) => void }) {
  const { reservation } = props;
  const ids = useId();
  const [amount, setAmount] = useState("");
  const [ended, setEnded] = useState(false);
  const [fromRecords, setFromRecords] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseVerifiedCost(amount);
  const amountError = submitted && "error" in parsed ? parsed.error : null;
  const ackError = submitted && !(ended && fromRecords) ? "Confirm both statements before you record the cost." : null;

  function submit() {
    setSubmitted(true);
    if ("error" in parsed || !ended || !fromRecords || props.pending || props.stale) return;
    props.onConfirm(parsed.value);
  }

  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!props.pending) props.onOpenChange(open); }}>
      <AlertDialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (props.pending) event.preventDefault(); }}
      >
        <form noValidate className="flex min-h-0 flex-col gap-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>Record the verified cost</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex flex-col gap-1">
                  <span>Held now: {formatMicroUsd(reservation.chargedMicroUsd)} in {formatMonth(reservation.period)}.</span>
                  <ReservationId reservation={reservation} />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-on-surface">
              <li>The admin session view is read-only. Use the session ID above to ask the person running the chat to stop it. For scheduled work, ask the job owner to disable future runs and wait for the current run to end.</li>
              <li>Disabling a job does not stop an active run.</li>
              <li>Get their confirmation and check provider records that no request from this turn is still running. Closing a reservation does not cancel requests already sent.</li>
              <li>Add up the cost from provider records and the recorded call usage.</li>
              <li>A missing response or usage record does not mean that the cost was $0.</li>
            </ol>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-amount`} className="text-sm font-semibold text-on-surface">Verified total cost (USD)</label>
              <div className="relative max-w-60">
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-on-surface-variant">$</span>
                <Input
                  id={`${ids}-amount`}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={props.stale !== null}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  aria-invalid={amountError ? true : undefined}
                  aria-describedby={amountError ? `${ids}-amount-error ${ids}-amount-hint` : `${ids}-amount-hint`}
                  className="pl-7 tabular-nums"
                />
              </div>
              {amountError ? <p id={`${ids}-amount-error`} className="text-sm text-danger">{amountError}</p> : null}
              <p id={`${ids}-amount-hint`} className={HINT}>
                {"value" in parsed && parsed.value === 0
                  ? "You entered $0. Use $0 only if provider records show no charge for this turn."
                  : "This total replaces the held charge."}
              </p>
            </div>
            <fieldset className="flex flex-col gap-2" disabled={props.stale !== null}>
              <legend className="mb-1 text-sm font-semibold text-on-surface">Before you record it</legend>
              <label className="flex gap-3 text-sm text-on-surface">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={ended} onChange={(event) => setEnded(event.target.checked)} />
                <span>No provider request from this turn is still running.</span>
              </label>
              <label className="flex gap-3 text-sm text-on-surface">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={fromRecords} onChange={(event) => setFromRecords(event.target.checked)} />
                <span>This total comes from provider records and recorded call usage.</span>
              </label>
              {ackError ? <p className="text-sm text-danger">{ackError}</p> : null}
            </fieldset>
            <p className="text-sm font-medium text-on-surface">You cannot undo or repeat this. The audit log records the amount under your name.</p>
            {props.stale ? <StaleNotice refresh={props.stale} /> : props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}
          </div>
          <AlertDialogFooter>
            <Button type="button" variant="outline" disabled={props.pending} onClick={() => props.onOpenChange(false)}>
              {props.stale ? "Back to the list" : "Cancel"}
            </Button>
            {props.stale ? null : (
              <Button type="submit" disabled={props.pending} aria-busy={props.pending}>
                {props.pending ? "Recording…" : props.error ? "Try again" : "Record verified cost"}
              </Button>
            )}
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
