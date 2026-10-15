"use client";

import { useCallback, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ModelSpendingReservation } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { refreshModelSpending, unresolvedReservations, type useModelSpending } from "../../../hooks/use-model-spending";
import { ApiError } from "../../../lib/api-client";
import { formatMicroUsd, formatMonth, formatUsd, type BudgetStatus } from "../../../lib/model-budget";
import { closeModelSpendingReservation, reconcileModelSpendingReservation } from "../../../lib/model-spending-api";
import { HINT, PILL_AMBER, PILL_BLUE, PILL_GRAY } from "../../../lib/ui-tokens";
import { CloseReservationDialog, ReconcileReservationDialog } from "./reservation-dialogs";

const UPDATED_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
});

type Action = { kind: "close" | "reconcile"; reservation: ModelSpendingReservation; key: number };
type StaleRefresh = "pending" | "done" | "failed";

function isStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function actionError(error: unknown, fallback: string): string | null {
  if (!error || isStale(error)) return null;
  if (error instanceof ApiError && error.status === 400) return "The server did not accept this request.";
  return fallback;
}

/**
 * Advanced recovery for reservations that did not settle. The counts come
 * from the month summary. The list is paginated and can include older months.
 */
export function BudgetRecovery(props: {
  query: ReturnType<typeof useModelSpending>;
  status: BudgetStatus;
  /** False while the summary is not current. Open dialogs stay, so a failed background check keeps a typed cost. */
  showList: boolean;
  month: string;
  defaultOpen: boolean;
  onStatus: (message: string) => void;
}) {
  const { query, status, month } = props;
  const queryClient = useQueryClient();
  const panelId = useId();
  const [open, setOpen] = useState(props.defaultOpen);
  const [action, setAction] = useState<Action | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [staleRefresh, setStaleRefresh] = useState<StaleRefresh>("pending");
  const triggerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLButtonElement | null>(null);
  const revealed = useRef(false);
  const reservations = unresolvedReservations(query.data);

  // A link from the Overview opens this section. Bring it into view once, not
  // again when the section comes back after a failed background check.
  const revealOnMount = useCallback((node: HTMLButtonElement | null) => {
    headingRef.current = node;
    if (node && props.defaultOpen && !revealed.current) {
      revealed.current = true;
      node.scrollIntoView?.({ block: "start" });
      node.focus({ preventScroll: true });
    }
  }, [props.defaultOpen]);

  const refresh = () => refreshModelSpending(queryClient, month);
  // After a 409, say that the list is current only when the reload worked.
  const refreshAfterConflict = (error: unknown) => {
    if (!isStale(error)) return;
    setStaleRefresh("pending");
    refreshModelSpending(queryClient, month, { throwOnError: true })
      .then(() => setStaleRefresh("done"), () => setStaleRefresh("failed"));
  };

  const close = useMutation({
    mutationFn: (reservationId: string) => closeModelSpendingReservation(reservationId),
    onSuccess: async () => {
      await refresh();
      setActionOpen(false);
      props.onStatus("Reservation closed. Its usage is now unknown and it needs reconciliation.");
    },
    onError: refreshAfterConflict
  });
  const reconcile = useMutation({
    mutationFn: (input: { reservationId: string; actualUsd: number }) => reconcileModelSpendingReservation(input.reservationId, input.actualUsd),
    onSuccess: async (_result, input) => {
      await refresh();
      setActionOpen(false);
      props.onStatus(`Verified cost of ${formatUsd(input.actualUsd)} recorded. The reservation is settled.`);
    },
    onError: refreshAfterConflict
  });

  function startAction(kind: Action["kind"], reservation: ModelSpendingReservation, trigger: HTMLElement) {
    triggerRef.current = trigger;
    close.reset();
    reconcile.reset();
    setAction((current) => ({ kind, reservation, key: (current?.key ?? 0) + 1 }));
    setActionOpen(true);
  }

  // The dialogs open without a Radix trigger. Return focus to the row button,
  // or to the section heading when the row left the list.
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const trigger = triggerRef.current;
    (trigger?.isConnected ? trigger : headingRef.current)?.focus();
  };

  const unknownNote = status.unknownThisMonth === 0 ? null
    : status.level === "unlimited" ? "They do not block new turns while there is no limit, but they will if you set one this month."
      : "Unknown usage blocks new turns until you reconcile it.";

  return (
    <>
      {props.showList ? (
        <section aria-label="Unresolved reservations" className="border-t border-outline-variant pt-4">
          <h3>
            <button
              ref={revealOnMount}
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
              className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold text-on-surface outline-none hover:bg-surface-container focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ChevronRightIcon aria-hidden="true" className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
              Advanced: unresolved reservations
              {status.unknownThisMonth > 0 ? <span className={PILL_AMBER}>{status.unknownThisMonth} unknown</span> : null}
            </button>
          </h3>
          {open ? (
            <div id={panelId} className="mt-3 flex flex-col gap-4">
              <p className="text-sm text-on-surface">
                This month: {status.activeThisMonth} active, {status.unknownThisMonth} with unknown usage.{unknownNote ? ` ${unknownNote}` : ""}
              </p>
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-on-surface">How to recover a reservation</summary>
                <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-on-surface-variant">
                  <li>The admin session view is read-only. Use its session ID to ask the person running the chat to stop it. For scheduled work, ask the job owner to disable future runs and wait for the current run to end. Disabling a job does not stop an active run.</li>
                  <li>If the reservation is still active, close it. This stops new model calls under it.</li>
                  <li>Get confirmation from the person responsible for the work and check provider records that all requests from this turn have ended. A closed reservation alone does not prove this.</li>
                  <li>Get the complete cost from provider records and the recorded call usage.</li>
                  <li>Reconcile the reservation with that total.</li>
                </ol>
              </details>

              {reservations.length === 0 && !query.hasNextPage ? (
                <p className={HINT}>No unresolved reservations.</p>
              ) : (
                <ul aria-label="Unresolved reservations list" className="divide-y divide-outline-variant rounded-lg border border-outline-variant">
                  {reservations.map((reservation) => (
                    <ReservationRow
                      key={reservation.reservationId}
                      reservation={reservation}
                      currentMonth={month}
                      onClose={(trigger) => startAction("close", reservation, trigger)}
                      onReconcile={(trigger) => startAction("reconcile", reservation, trigger)}
                    />
                  ))}
                </ul>
              )}

              {query.hasNextPage || query.isFetchNextPageError ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} aria-busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                    {query.isFetchingNextPage ? "Loading…" : query.isFetchNextPageError ? "Try loading more again" : "Load more reservations"}
                  </Button>
                  {query.isFetchNextPageError ? <p role="alert" className="text-sm text-danger">Could not load more reservations.</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {action?.kind === "close" ? (
        <CloseReservationDialog
          key={action.key}
          open={actionOpen}
          onOpenChange={setActionOpen}
          onCloseAutoFocus={restoreFocus}
          reservation={action.reservation}
          currentMonth={month}
          blocksNewTurns={status.limitMicro !== null && status.limitMicro > 0}
          pending={close.isPending}
          stale={isStale(close.error) ? staleRefresh : null}
          error={actionError(close.error, "Could not close the reservation. Try again.")}
          onConfirm={() => close.mutate(action.reservation.reservationId)}
        />
      ) : null}
      {action?.kind === "reconcile" ? (
        <ReconcileReservationDialog
          key={action.key}
          open={actionOpen}
          onOpenChange={setActionOpen}
          onCloseAutoFocus={restoreFocus}
          reservation={action.reservation}
          pending={reconcile.isPending}
          stale={isStale(reconcile.error) ? staleRefresh : null}
          error={actionError(reconcile.error, "Could not record the cost. Your entry is kept. Try again.")}
          onConfirm={(actualUsd) => reconcile.mutate({ reservationId: action.reservation.reservationId, actualUsd })}
        />
      ) : null}
    </>
  );
}

function ReservationRow(props: {
  reservation: ModelSpendingReservation;
  currentMonth: string;
  onClose: (trigger: HTMLElement) => void;
  onReconcile: (trigger: HTMLElement) => void;
}) {
  const { reservation } = props;
  const idId = useId();
  const older = reservation.period !== props.currentMonth;
  return (
    <li className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={reservation.status === "unknown" ? PILL_AMBER : PILL_BLUE}>
            {reservation.status === "unknown" ? "Unknown usage" : "Active"}
          </span>
          <span className="font-semibold text-on-surface tabular-nums">{formatMicroUsd(reservation.chargedMicroUsd)} held</span>
          <span className="text-on-surface-variant">{reservation.turnContext === "scheduled" ? "Scheduled job" : "Chat"}</span>
          <span className="text-on-surface-variant">{formatMonth(reservation.period)}</span>
          {older ? <span className={PILL_GRAY}>Earlier month, does not block</span> : null}
        </div>
        <p id={idId} className="font-mono text-xs text-on-surface-variant wrap-anywhere">{reservation.reservationId}</p>
        <p className="text-xs text-on-surface-faint">
          Updated {UPDATED_FORMAT.format(new Date(reservation.updatedAt))} UTC ·{" "}
          <Link
            className="text-info underline underline-offset-4"
            href={`/admin/sessions/${encodeURIComponent(reservation.sessionId)}`}
            aria-label={`Open session ${reservation.sessionId}`}
          >
            Open session
          </Link>
        </p>
      </div>
      {reservation.status === "reserved" ? (
        <Button variant="outline" size="sm" className="self-start" aria-describedby={idId} onClick={(event) => props.onClose(event.currentTarget)}>
          Close reservation…
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="self-start" aria-describedby={idId} onClick={(event) => props.onReconcile(event.currentTarget)}>
          Reconcile…
        </Button>
      )}
    </li>
  );
}
