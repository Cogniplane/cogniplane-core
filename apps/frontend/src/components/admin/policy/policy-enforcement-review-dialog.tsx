"use client";

import { useRef } from "react";
import { TriangleAlert } from "lucide-react";

import type { TenantSettings } from "@cogniplane/shared-types";

import type { EnforcementReview } from "../../../hooks/use-policy-enforcement";
import { MonitorEvidenceLimits, MonitorRuleList } from "./policy-monitor-summary";
import {
  HISTORICAL_EVIDENCE_NOTE,
  ZERO_EVIDENCE_DETAIL,
  ZERO_EVIDENCE_TITLE,
  consequenceLines,
  formatUtc,
  formatWindow,
  inactiveRuleCount,
  plural
} from "./policy-monitor.logic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

type Props = {
  review: EnforcementReview;
  /** Settings as the page has them now. */
  settings: TenantSettings | null;
  saving: boolean;
  reloading: boolean;
  reloadFailed: boolean;
  onClose: () => void;
  onEnable: () => void;
  /** Read the evidence and settings again and restart the review. */
  onReread: () => void;
  onReloadSettings: () => void;
  /** Move focus back to the page after the dialog closes. */
  onRestoreFocus: () => void;
};

/**
 * What blocks the Enable action, from the review state and the settings that
 * the page has now. Null when enabling is allowed.
 */
export function enableBlocker(props: Pick<Props, "review" | "settings" | "saving" | "reloading" | "reloadFailed">):
  | null
  | "reading"
  | "readFailed"
  | "saving"
  | "reloading"
  | "reloadFailed"
  | "alreadyOn"
  | "changed" {
  const { review, settings } = props;
  if (review.phase === "reading" || review.phase === "closed") return "reading";
  if (review.phase === "readFailed") return "readFailed";
  if (props.saving) return "saving";
  if (props.reloading) return "reloading";
  if (props.reloadFailed || !settings) return "reloadFailed";
  if (settings.policyEnforcementMode === "enforce") return "alreadyOn";
  if (settings.version !== review.snapshot.settingsVersion) return "changed";
  return null;
}

export function PolicyEnforcementReviewDialog(props: Props) {
  const { review, settings, saving } = props;
  const keepRef = useRef<HTMLButtonElement>(null);
  const blocker = enableBlocker(props);
  const failure = review.phase === "ready" ? review.failure : null;
  // "Keep Monitor" is true only when the page knows the mode. After a failed
  // read or an unconfirmed save, closing changes nothing, so say only that.
  const uncertain = review.phase === "readFailed" || failure !== null || props.reloadFailed;
  const closeLabel = blocker === "alreadyOn" ? "Close" : uncertain ? "Back to policies" : "Keep Monitor";

  return (
    <Dialog
      open={review.phase !== "closed"}
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Focus the safe action first, as an alert dialog does.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
        // The review can open from a link, so the page selects the focus target.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onRestoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
        className="flex max-h-[min(90dvh,52rem)] flex-col gap-0 overflow-hidden border-outline-variant bg-surface p-0 text-on-surface sm:max-w-2xl"
      >
        <DialogHeader className="gap-1.5 border-b border-outline-variant px-5 py-4 text-left sm:px-6">
          <p className={SECTION_LABEL}>Policy enforcement · organization</p>
          <DialogTitle className="text-lg leading-snug text-on-surface">Enable enforcement</DialogTitle>
          <DialogDescription className="text-sm text-on-surface-variant">
            From the next turn of each session, matching rules block tool calls or ask for approval.
            Turns already running keep their current mode. You can switch back to Monitor at any time.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6" aria-busy={review.phase === "reading"}>
          {review.phase === "reading" ? (
            <div role="status" aria-label="Reading the latest evidence and settings" className="flex flex-col gap-3">
              <p className="text-sm text-on-surface-variant">Reading the latest evidence and settings...</p>
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/5" />
            </div>
          ) : null}

          {review.phase === "readFailed" ? (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger-surface p-3 text-sm">
              <p className="font-semibold text-danger">Could not read the latest evidence or settings.</p>
              <p className="mt-1 text-on-surface [overflow-wrap:anywhere]">{review.message}</p>
              <p className="mt-1 text-on-surface-variant">
                The review cannot continue until both reads succeed.
              </p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={props.onReread}>
                Read again
              </Button>
            </div>
          ) : null}

          {review.phase === "ready" ? (
            <ReviewBody
              review={review}
              settings={settings}
              blocker={blocker}
              reloadFailed={props.reloadFailed}
              onReread={props.onReread}
              onReloadSettings={props.onReloadSettings}
            />
          ) : null}
        </div>

        {failure && blocker !== "alreadyOn" && blocker !== "changed" ? (
          <div role="alert" className="border-t border-danger/30 bg-danger-surface px-5 py-3 text-sm sm:px-6">
            <p className="font-semibold text-danger">
              {failure.kind === "conflict" ? "Settings changed" : "Could not confirm the save."}
            </p>
            <p className="mt-0.5 text-on-surface [overflow-wrap:anywhere]">
              {failure.message}{" "}
              {props.reloading
                ? "Loading the current settings..."
                : props.reloadFailed
                  ? "The current settings could not be loaded. Load them before you try again."
                  : "The current settings are loaded and still show Monitor. You can try again."}
            </p>
          </div>
        ) : null}

        <DialogFooter className="border-t border-outline-variant px-5 py-3 sm:px-6">
          <Button ref={keepRef} type="button" variant="outline" disabled={saving} onClick={props.onClose}>
            {closeLabel}
          </Button>
          {blocker === "alreadyOn" ? null : (
            <Button type="button" disabled={blocker !== null} onClick={props.onEnable}>
              {saving ? "Enabling..." : failure && blocker === null ? "Try again" : "Enable enforcement"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewBody({
  review,
  settings,
  blocker,
  reloadFailed,
  onReread,
  onReloadSettings
}: {
  review: Extract<EnforcementReview, { phase: "ready" }>;
  settings: TenantSettings | null;
  blocker: ReturnType<typeof enableBlocker>;
  reloadFailed: boolean;
  onReread: () => void;
  onReloadSettings: () => void;
}) {
  const { summary, settingsVersion, readAt } = review.snapshot;
  const lines = consequenceLines(summary.totals);
  const inactive = inactiveRuleCount(summary);

  return (
    <div className="flex flex-col gap-5">
      {blocker === "alreadyOn" ? (
        <div role="status" className="rounded-lg border border-success/40 bg-success-surface p-3 text-sm">
          <p className="font-semibold text-success">Enforce is on.</p>
          <p className="mt-1 text-on-surface">
            The current settings (v{settings?.version}) show Enforce. The change was saved, here or
            elsewhere, even if a response failed.
          </p>
        </div>
      ) : null}

      {blocker === "changed" ? (
        <div role="alert" className="rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm">
          <p className="font-semibold text-warning">
            Organization settings changed to v{settings?.version} after this review opened (v{settingsVersion}).
          </p>
          <p className="mt-1 text-on-surface">
            Read the evidence and settings again before you enable enforcement, so that you do not
            overwrite the newer change without seeing it.
          </p>
          <Button type="button" size="sm" className="mt-3" onClick={onReread}>
            Review again
          </Button>
        </div>
      ) : null}

      {reloadFailed ? (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-surface p-3 text-sm">
          <p className="font-semibold text-danger">Could not load the current settings.</p>
          <p className="mt-1 text-on-surface">
            A save can succeed even when its response fails. Load the settings to see if Enforce is
            already on.
          </p>
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={onReloadSettings}>
            Load current settings
          </Button>
        </div>
      ) : null}

      <section aria-labelledby="review-evidence-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 id="review-evidence-title" className="text-sm font-semibold text-on-surface">
            What Enforce would have done in the last 7 days
          </h3>
          <p className="text-xs text-on-surface-faint">
            Read at {formatUtc(readAt)} UTC · {formatWindow(summary.windowStart, summary.windowEnd)}
          </p>
        </div>
        <p className="text-xs text-on-surface-faint">{HISTORICAL_EVIDENCE_NOTE}</p>

        {lines.length === 0 ? (
          <div className="flex gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-on-surface">{ZERO_EVIDENCE_TITLE}</p>
              <p className="mt-0.5 text-on-surface-variant">
                {ZERO_EVIDENCE_DETAIL} Rules can also match tool calls later.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line) => (
              <li key={line.key} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-3 text-sm">
                <span className="text-right text-xl font-semibold tabular-nums text-on-surface">{line.count.toLocaleString()}</span>
                <span className="text-on-surface">{line.text}</span>
              </li>
            ))}
          </ul>
        )}

        {inactive > 0 ? (
          <p className="text-xs text-warning">
            {plural(inactive, "rule")} in this list {inactive === 1 ? "is" : "are"} now disabled or
            deleted and will not act under Enforce. Other rules can match the same tool calls, so
            these counts do not predict what Enforce will do.
          </p>
        ) : null}
      </section>

      {summary.rules.length > 0 ? (
        <section aria-labelledby="review-rules-title">
          <p id="review-rules-title" className={SECTION_LABEL}>By rule</p>
          <div className="mt-2">
            <MonitorRuleList summary={summary} headingId="review-rules-title" />
          </div>
          <p className="mt-2 text-xs text-on-surface-variant">
            To see the matches for a rule, keep Monitor and use the link on that rule's row. Deleted rules have no row.
          </p>
        </section>
      ) : null}

      <div className="rounded-md bg-surface-container-low px-3 py-2">
        <MonitorEvidenceLimits summary={summary} />
      </div>

      <p className="text-xs text-on-surface-faint">
        This review uses organization settings v{settingsVersion}. If they change before you
        enable enforcement, the review asks you to read them again.
      </p>
    </div>
  );
}
