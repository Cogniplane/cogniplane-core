"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useModelSpending, useUtcMonth } from "../../../hooks/use-model-spending";
import {
  BUDGET_WARNING_PERCENT,
  budgetStatus,
  budgetStatusCopy,
  formatMicroUsd,
  formatMonth,
  type BudgetStatus,
  type BudgetTone
} from "../../../lib/model-budget";
import { PILL_AMBER, PILL_GRAY, PILL_GREEN, PILL_RED } from "../../../lib/ui-tokens";
import { BudgetDialog } from "./budget-dialog";
import { BudgetRecovery } from "./budget-recovery";

const TONE_PILL: Record<BudgetTone, string> = { neutral: PILL_GRAY, success: PILL_GREEN, warning: PILL_AMBER, danger: PILL_RED };
const TONE_FILL: Record<BudgetTone, string> = { neutral: "bg-on-surface-variant", success: "bg-brand", warning: "bg-warning", danger: "bg-danger" };

/**
 * The model budget for the current UTC month: status, the admission rule as a
 * meter, and the decisions an administrator can take. Settings open in a
 * dialog from one contextual button.
 */
export function ModelBudgetPanel() {
  const month = useUtcMonth();
  const query = useModelSpending(month);
  const router = useRouter();
  const pathname = usePathname();
  const intent = useSearchParams().get("budget");
  const loaded = query.data?.pages[0];
  // The last summary that loaded, for any month. After a month change or a
  // failed load the query has no data, but the open dialogs stay mounted with
  // this summary, so they keep their drafts. It never shows as the status.
  const [retained, setRetained] = useState(loaded);
  if (loaded && loaded !== retained) setRetained(loaded);
  const summary = loaded ?? retained;
  // A failed "Load more" keeps the summary. Any other failure hides it, so the
  // panel never shows an old state as if it were current.
  const summaryFailed = query.isError && !query.isFetchNextPageError;
  const current = summaryFailed ? undefined : loaded;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [linkDismissed, setLinkDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // `?budget=edit` from the Overview opens the dialog once the budget is loaded.
  const editOpen = dialogOpen || (intent === "edit" && Boolean(current) && !linkDismissed);

  function openDialog() {
    setAnnouncement("");
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (open) return;
    setLinkDismissed(true);
    if (intent === "edit") router.replace(pathname, { scroll: false });
  }

  // The dialog opens without a Radix trigger. Read the refs only in this event.
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    (changeButtonRef.current ?? headingRef.current)?.focus();
  };

  const status = current ? budgetStatus(current) : null;
  const copy = status ? budgetStatusCopy(status) : null;

  return (
    <section id="model-budget" aria-labelledby="model-budget-heading" className="flex flex-col gap-5 rounded-xl border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 ref={headingRef} id="model-budget-heading" tabIndex={-1} className="text-lg font-semibold text-on-surface outline-none">Model budget</h2>
            {copy ? <span className={TONE_PILL[copy.tone]}>{copy.label}</span> : null}
          </div>
          <p className="mt-1 text-sm text-on-surface-variant">{formatMonth(month)}, UTC. Estimated model cost, not a provider invoice cap.</p>
        </div>
        {status ? (
          <Button ref={changeButtonRef} variant={status.level === "unlimited" ? "default" : "outline"} size="sm" className="self-start" onClick={openDialog}>
            {status.level === "unlimited" ? "Set a limit" : "Change budget"}
          </Button>
        ) : null}
      </header>

      <p role="status" aria-live="polite" className={cn("text-sm text-success", !announcement && "sr-only")}>{announcement}</p>

      {query.isPending ? (
        <div role="status" aria-label="Loading the model budget" className="flex flex-col gap-3">
          <Skeleton className="h-7 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : null}

      {summaryFailed ? (
        <div className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between">
          <p role="alert" className="text-sm text-danger">Could not check the model budget. Its status is unknown.</p>
          <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? "Checking…" : "Retry budget check"}
          </Button>
        </div>
      ) : null}

      {status && copy ? (
        <>
          <BudgetFigures status={status} />
          <p className="max-w-[70ch] text-sm text-on-surface">{copy.sentence}</p>
          <BudgetFacts status={status} />
          <details className="group text-sm">
            <summary className="cursor-pointer font-medium text-on-surface">What this budget counts</summary>
            <ul className="mt-2 flex max-w-[70ch] list-disc flex-col gap-1.5 pl-5 text-on-surface-variant">
              <li>Estimated model cost from the product&apos;s price table. Provider invoices can differ.</li>
              <li>&quot;Charged or held&quot; includes the full hold of turns still running and of usage that is unknown. It can go above the limit, because a turn can finish a model call that started before its hold ran out.</li>
              <li>Not counted: sandbox execution, storage, external tool services and PII processing.</li>
              <li>Turns that start while there is no limit are not in this ledger. For estimates over a period, use the <a className="text-info underline underline-offset-4" href="#token-reports">token reports</a>.</li>
            </ul>
          </details>
        </>
      ) : null}

      {/* Kept outside the status block: a failed background check must not discard a draft. */}
      {summary ? (
        <BudgetRecovery
          query={query}
          status={status ?? budgetStatus(summary)}
          showList={status !== null}
          month={month}
          defaultOpen={intent === "recovery"}
          onStatus={setAnnouncement}
        />
      ) : null}
      {summary ? (
        <BudgetDialog
          key={dialogKey}
          open={editOpen}
          onOpenChange={handleDialogOpenChange}
          onCloseAutoFocus={restoreFocus}
          month={month}
          summary={summary}
          current={current !== undefined}
          onSaved={(message) => { handleDialogOpenChange(false); setAnnouncement(message); }}
        />
      ) : null}
    </section>
  );
}

function BudgetFigures({ status }: { status: BudgetStatus }) {
  const charged = formatMicroUsd(status.chargedMicro);
  if (status.limitMicro === null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-semibold tracking-tight text-on-surface">No monthly limit</p>
        {status.chargedMicro > 0 ? (
          <p className="text-sm text-on-surface-variant">
            The ledger holds <span className="font-semibold text-on-surface tabular-nums">{charged}</span> this month, from turns that started while a limit was set.
          </p>
        ) : null}
      </div>
    );
  }
  if (status.limitMicro === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-semibold tracking-tight text-on-surface tabular-nums">
          {charged} <span className="text-base font-normal text-on-surface-variant">charged or held, limit $0.00</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-2xl font-semibold tracking-tight text-on-surface tabular-nums">
        {charged} <span className="text-base font-normal text-on-surface-variant">of {formatMicroUsd(status.limitMicro)} charged or held</span>
      </p>
      <BudgetMeter status={status} limitMicro={status.limitMicro} />
    </div>
  );
}

/**
 * Solid: charged or held. Hatched: the hold that the next turn needs. When
 * the hatched part does not fit before the limit, no new turn can start.
 */
function BudgetMeter({ status, limitMicro }: { status: BudgetStatus; limitMicro: number }) {
  const tone = budgetStatusCopy(status).tone;
  const chargedShare = Math.min(100, (status.chargedMicro / limitMicro) * 100);
  const holdShare = Math.max(0, Math.min(100 - chargedShare, (status.reservationMicro / limitMicro) * 100));
  const percent = status.percent ?? 0;
  const over = status.remainingMicro !== null && status.remainingMicro < 0 ? -status.remainingMicro : 0;
  const valueText = `${formatMicroUsd(status.chargedMicro)} of ${formatMicroUsd(limitMicro)} charged or held, ${percent}%`
    + (over ? `, ${formatMicroUsd(over)} over the limit` : "")
    + (status.insufficient ? ". The next turn's hold does not fit." : ". The next turn's hold fits.");
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Monthly budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        aria-valuetext={valueText}
        className="relative h-3 overflow-hidden rounded-full bg-surface-container-high"
      >
        <div className={cn("absolute inset-y-0 left-0", TONE_FILL[tone])} style={{ width: `${chargedShare}%` }} />
        {holdShare > 0 || status.insufficient ? (
          <div
            className={cn(
              "absolute inset-y-0 bg-[repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_5px)] opacity-70",
              status.insufficient ? "text-danger" : "text-on-surface-variant"
            )}
            style={{ left: `${chargedShare}%`, width: `${status.insufficient ? 100 - chargedShare : holdShare}%` }}
          />
        ) : null}
        <div aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-surface-container-lowest" style={{ left: `${BUDGET_WARNING_PERCENT}%` }} />
      </div>
      {/* The legend names the warning line. A label under the line would overlap a long limit amount. */}
      <div aria-hidden="true" className="flex flex-wrap justify-between gap-x-3 text-[0.7rem] text-on-surface-faint tabular-nums">
        <span>$0</span>
        <span>{formatMicroUsd(limitMicro)}</span>
      </div>
      <p aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
        <span className="inline-flex items-center gap-1.5"><span className={cn("size-2.5 rounded-sm", TONE_FILL[tone])} />Charged or held</span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm bg-[repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_3px)]", status.insufficient ? "text-danger" : "text-on-surface-variant")} />
          {status.insufficient ? "Next turn's hold does not fit" : "Next turn's hold"}
        </span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-0.5 bg-on-surface-variant" />Warning at {BUDGET_WARNING_PERCENT}%</span>
      </p>
    </div>
  );
}

function BudgetFacts({ status }: { status: BudgetStatus }) {
  const remaining = status.remainingMicro;
  const facts: Array<{ label: string; value: string; alert?: boolean }> = [];
  if (remaining !== null) {
    facts.push(remaining < 0
      ? { label: "Over the limit by", value: formatMicroUsd(-remaining), alert: true }
      : { label: "Remaining", value: formatMicroUsd(remaining), alert: status.insufficient });
  }
  facts.push({ label: status.limitMicro === null ? "Hold per turn (with a limit)" : "Hold per turn", value: formatMicroUsd(status.reservationMicro) });
  facts.push({ label: "Active reservations", value: String(status.activeThisMonth) });
  facts.push({ label: "Unknown usage", value: String(status.unknownThisMonth), alert: status.unknownBlocks });
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-outline-variant py-4 sm:grid-cols-4">
      {facts.map((fact) => (
        <div key={fact.label} className="min-w-0">
          <dt className="text-xs text-on-surface-variant">{fact.label}</dt>
          <dd className={cn("mt-0.5 text-base font-semibold tabular-nums", fact.alert ? "text-danger" : "text-on-surface")}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
