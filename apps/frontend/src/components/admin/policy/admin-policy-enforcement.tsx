"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { usePolicyEnforcement } from "../../../hooks/use-policy-enforcement";
import { Button } from "../../ui/button";
import { PolicyEnforcementReviewDialog } from "./policy-enforcement-review-dialog";
import { OverviewRow } from "../overview-row";
import { REVIEW_ENFORCEMENT, REVIEW_PARAM, plural } from "./policy-monitor.logic";

/** The Policy Center mode as one row: what a matching rule does now, and the last 7 days of Monitor records. */
export function AdminPolicyEnforcement({ meta }: { meta?: ReactNode } = {}) {
  const enforcement = usePolicyEnforcement();
  const { settings, review, notice, summary } = enforcement;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusStatusOnCloseRef = useRef(false);

  // The Overview links here with ?review=enforcement. Open the review once
  // the mode is known, then drop the parameter so a reload does not reopen it.
  const reviewRequested = searchParams.get(REVIEW_PARAM) === REVIEW_ENFORCEMENT;
  const mode = settings?.policyEnforcementMode;
  const { openReview } = enforcement;
  useEffect(() => {
    if (!reviewRequested || !mode) return;
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(REVIEW_PARAM);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    if (mode === "monitor") void openReview();
    // Run once for each request in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRequested, mode]);

  if (!settings) {
    return (
      <section aria-labelledby="policy-enforcement-title">
        {meta}
        <h2 id="policy-enforcement-title" className="sr-only">Policy enforcement</h2>
        <div aria-live="polite" className="mt-2 text-sm">
          <p className={enforcement.loadError ? "text-danger" : "text-on-surface-variant"}>
            {enforcement.loadError ?? "Loading policy enforcement..."}
          </p>
          {enforcement.loadError ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void enforcement.reloadSettings()}>
              Retry settings
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  const enforcing = settings.policyEnforcementMode === "enforce";
  const busy = enforcement.saving || enforcement.reloading;

  async function enable(): Promise<void> {
    if (await enforcement.enable()) focusStatusOnCloseRef.current = true;
  }

  function restoreFocus(): void {
    const toStatus = focusStatusOnCloseRef.current;
    focusStatusOnCloseRef.current = false;
    (toStatus || !reviewButtonRef.current ? statusRef.current : reviewButtonRef.current)?.focus();
  }

  const evidence = summary.data;
  const evidenceFailed = summary.isError && !evidence;
  // Keep the retry button while it fetches, so focus stays on it.
  const evidenceStale = summary.isError && Boolean(evidence);
  let evidenceLine = "";
  if (!enforcing) {
    if (summary.isPending && !evidence) evidenceLine = " Checking the last 7 days...";
    else if (!evidence) evidenceLine = "";
    else if (evidence.totals.total === 0) evidenceLine = " No block or approval records counted in the last 7 days. That does not prove Enforce is safe.";
    else {
      const { block, approvalInteractive, approvalScheduled, approvalUnknownContext } = evidence.totals;
      // Scheduled runs have nobody to ask, so Enforce denies those calls. Keep them apart.
      const parts = [
        block ? `blocked ${plural(block, "tool call")}` : null,
        approvalInteractive + approvalUnknownContext ? `asked for approval on ${plural(approvalInteractive + approvalUnknownContext, "tool call")}` : null,
        approvalScheduled ? `denied ${plural(approvalScheduled, "scheduled tool call")}` : null
      ].filter((part): part is string => part !== null);
      const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
      evidenceLine = ` In the last 7 days, Enforce would have ${listed}.`;
    }
  }

  return (
    <section aria-labelledby="policy-enforcement-title">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
        {meta}
        {meta ? <span aria-hidden="true">·</span> : null}
        <span>Settings v{settings.version}</span>
      </div>
      <h2 id="policy-enforcement-title" className="sr-only">Policy enforcement</h2>
      <div className="mt-4 border-y border-outline-variant">
        <OverviewRow
          title={<><span aria-hidden className={`inline-block size-2 rounded-full ${enforcing ? "bg-success" : "bg-warning"}`} />{enforcing ? "Enforce is active" : "Monitor is active"}</>}
          busy={!enforcing && summary.isPending && !evidence}
          status={<>
            {enforcing
              ? "When a rule matches, it blocks the tool call or asks for approval. On scheduled runs, an approval rule denies the call."
              : "When a rule matches, it is only recorded. Rules do not block tool calls or ask for approval."}
            {evidenceLine}
            {evidenceFailed && !summary.isFetching ? <span role="alert" className="text-danger"> Could not load the last 7 days.</span> : null}
            {evidenceStale && !summary.isFetching ? <span role="alert" className="text-danger"> Could not refresh. These numbers are from the last successful read.</span> : null}
          </>}
        >
          {!enforcing && (evidenceFailed || evidenceStale) ? (
            <Button type="button" size="sm" variant="outline" disabled={summary.isFetching} onClick={() => void summary.refetch()}>
              {summary.isFetching ? "Retrying..." : "Retry evidence"}
            </Button>
          ) : null}
          {enforcing ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || enforcement.settingsUncertain}
              aria-describedby={enforcement.settingsUncertain ? "policy-settings-uncertain" : undefined}
              onClick={async () => {
                await enforcement.switchToMonitor();
                // The button goes away with the mode, so focus the result.
                statusRef.current?.focus();
              }}
            >
              {enforcement.saving ? "Switching..." : "Switch to Monitor"}
            </Button>
          ) : (
            <Button ref={reviewButtonRef} type="button" variant="outline" size="sm" disabled={busy} onClick={() => void enforcement.openReview()}>
              Review enforcement
            </Button>
          )}
        </OverviewRow>
      </div>

      <div
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring/50 empty:hidden"
      >
        {notice ? (
          <div className={`mt-3 rounded-lg border p-3 text-sm ${notice.tone === "done" ? "border-success/40 bg-success-surface" : "border-danger/30 bg-danger-surface"}`}>
            <p className="text-on-surface">{notice.text}</p>
          </div>
        ) : null}
        {enforcement.settingsUncertain ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <p id="policy-settings-uncertain" className="text-danger">
              Could not load the current settings. The mode shown can be out of date. Load them
              before you change the mode.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={enforcement.reloading}
              onClick={() => void enforcement.reloadSettings()}
            >
              {enforcement.reloading ? "Loading..." : "Load current settings"}
            </Button>
          </div>
        ) : null}
      </div>

      <PolicyEnforcementReviewDialog
        review={review}
        settings={settings}
        saving={enforcement.saving}
        reloading={enforcement.reloading}
        reloadFailed={enforcement.reloadFailed}
        onClose={enforcement.closeReview}
        onEnable={() => void enable()}
        onReread={() => void enforcement.openReview()}
        onReloadSettings={() => void enforcement.reloadSettings()}
        onRestoreFocus={restoreFocus}
      />
    </section>
  );
}
