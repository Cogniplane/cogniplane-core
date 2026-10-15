"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { PolicyDecision, PolicyEffect, PolicyRule, PolicySeverity } from "@cogniplane/shared-types";

import {
  ALL_EFFECTS,
  ALL_SEVERITIES,
  decisionFiltersFromDraft,
  EFFECT_LABELS,
  SEVERITY_LABELS
} from "./admin-policy-form.logic";
import {
  decisionFiltersKey,
  decisionScope,
  hasDecisionScope,
  type DecisionFilters
} from "./admin-policy-decision-url";
import { DECISIONS_ANCHOR, formatWindow, formatUtc } from "./policy-monitor.logic";
import { useDecisionDetail } from "../../../hooks/use-policy-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PILL_GRAY, PILL_RED, SECTION_LABEL } from "../../../lib/ui-tokens";

const ANY = "any";

type Props = {
  decisions: PolicyDecision[];
  total: number;
  page: number;
  pageCount: number;
  offset: number;
  hasMore: boolean;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  filters: DecisionFilters;
  /** Problems with filters in the URL. When set, no rows are loaded. */
  urlProblems?: string[];
  /** Current rules, to name the rule in the scope. */
  rules?: PolicyRule[];
  onApply: (filters: DecisionFilters) => void;
  onNext: () => void;
  onPrev: () => void;
  onRefresh: () => void;
};

export function AdminPolicyDecisionsCard({
  decisions,
  total,
  page,
  pageCount,
  offset,
  hasMore,
  loading,
  fetching,
  error,
  filters,
  urlProblems = [],
  rules = [],
  onApply,
  onNext,
  onPrev,
  onRefresh
}: Props) {
  // Draft filter state lives locally; it's applied to the query on "Apply" so
  // each keystroke in the tool box doesn't refire the request.
  const [outcome, setOutcome] = useState<PolicyEffect | typeof ANY>(filters.outcomes?.[0] ?? ANY);
  const [enforced, setEnforced] = useState<"any" | "true" | "false">(
    filters.enforced === undefined ? ANY : filters.enforced ? "true" : "false"
  );
  const [severity, setSeverity] = useState<PolicySeverity | typeof ANY>(filters.severities?.[0] ?? ANY);
  const [toolText, setToolText] = useState((filters.toolNames ?? []).join(", "));
  const [from, setFrom] = useState(filters.from ?? "");
  const [to, setTo] = useState(filters.to ?? "");

  // The filters can change from outside the bar (a summary link, back/forward).
  // Then the draft follows them, so the bar never shows a scope that is not applied.
  const filtersKey = decisionFiltersKey(filters);
  // Filters that the scope bar does not show. The Filter button counts them, and the panel
  // opens when they arrive from outside, so the list is never filtered out of sight.
  const activeFilterCount = [
    filters.outcomes?.length, filters.enforced !== undefined, filters.severities?.length, filters.toolNames?.length, filters.from || filters.to
  ].filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(activeFilterCount > 0);
  const [draftKey, setDraftKey] = useState(filtersKey);
  if (draftKey !== filtersKey) {
    setDraftKey(filtersKey);
    if (activeFilterCount > 0) setFiltersOpen(true);
    setOutcome(filters.outcomes?.[0] ?? ANY);
    setEnforced(filters.enforced === undefined ? ANY : filters.enforced ? "true" : "false");
    setSeverity(filters.severities?.[0] ?? ANY);
    setToolText((filters.toolNames ?? []).join(", "));
    setFrom(filters.from ?? "");
    setTo(filters.to ?? "");
  }

  const [openId, setOpenId] = useState<string | null>(null);
  const filtersId = useId();
  const scoped = hasDecisionScope(filters);
  const exactWindow = Boolean(filters.since || filters.until);

  // Move focus to the scope when a link on this page changes it, so a keyboard
  // or screen reader user lands on the rows the link opened.
  const scopeRef = useRef<HTMLDivElement>(null);
  const scopeKey = decisionFiltersKey(decisionScope(filters));
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    if (scoped) scopeRef.current?.focus();
  }, [scopeKey, scoped]);

  const applyDraft = () => {
    const draft = decisionFiltersFromDraft({ outcome, enforced, severity, toolText, from, to });
    // The scope stays until it is cleared. An exact window replaces the date range.
    onApply(exactWindow ? { ...decisionScope(filters), ...draft, from: undefined, to: undefined } : { ...decisionScope(filters), ...draft });
  };

  const clearDraft = () => {
    setOutcome(ANY);
    setEnforced(ANY);
    setSeverity(ANY);
    setToolText("");
    setFrom("");
    setTo("");
    onApply({});
  };

  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + decisions.length;

  return (
    <section id={DECISIONS_ANCHOR} aria-labelledby="policy-decisions-title" className="scroll-mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="policy-decisions-title" className="text-lg font-semibold text-on-surface">Rule matches</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            A row appears each time a rule matches a connection (MCP) tool call. Applied means Enforce
            blocked the call or asked for approval. Recorded only means Monitor noted it. Shell and file
            approvals are not listed here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={fetching}>
            Refresh
          </Button>
          <Button type="button" variant="outline" size="sm" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen(!filtersOpen)}>
            {activeFilterCount ? `Filter (${activeFilterCount})` : "Filter"}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-3 border-t border-outline-variant pt-3">
        {urlProblems.length > 0 ? (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger-surface p-3 text-sm">
            <p className="font-semibold text-danger">This link has filters that could not be read.</p>
            <ul className="mt-1 list-disc pl-5 text-on-surface">
              {urlProblems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
            <p className="mt-1 text-on-surface-variant">No rows are shown, so that rows from a wider scope do not look like a match.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={clearDraft}>
              Clear filters
            </Button>
          </div>
        ) : null}
        {scoped ? (
          <DecisionScope ref={scopeRef} filters={filters} rules={rules} total={loading ? null : total} onClear={clearDraft} />
        ) : null}
        <div id={filtersId} hidden={!filtersOpen} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-outcome">Outcome</Label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as PolicyEffect | typeof ANY)}>
              <SelectTrigger id="dec-outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {ALL_EFFECTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EFFECT_LABELS[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-enforced">Enforcement</Label>
            <Select value={enforced} onValueChange={(v) => setEnforced(v as "any" | "true" | "false")}>
              <SelectTrigger id="dec-enforced">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                <SelectItem value="true">Applied</SelectItem>
                <SelectItem value="false">Recorded only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-severity">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as PolicySeverity | typeof ANY)}>
              <SelectTrigger id="dec-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {ALL_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SEVERITY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-tool">Tool name</Label>
            <Input
              id="dec-tool"
              value={toolText}
              onChange={(e) => setToolText(e.target.value)}
              placeholder="github_create_pr"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-from">From</Label>
            <Input id="dec-from" type="date" value={from} disabled={exactWindow} aria-describedby={exactWindow ? "dec-window-note" : undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-to">To</Label>
            <Input id="dec-to" type="date" value={to} disabled={exactWindow} aria-describedby={exactWindow ? "dec-window-note" : undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          {exactWindow ? (
            <p id="dec-window-note" className="text-xs text-on-surface-faint sm:col-span-3 lg:col-span-6">
              The scope sets an exact time window, so the dates are off. Clear the filters to pick dates.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={applyDraft} disabled={fetching}>
            Apply filters
          </Button>
          <Button type="button" variant="outline" onClick={clearDraft} disabled={fetching}>
            Clear
          </Button>
        </div>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {/* Table */}
        {urlProblems.length > 0 ? null : loading ? (
          <p className="text-sm text-on-surface-faint">Loading rule matches…</p>
        ) : decisions.length === 0 ? (
          error ? null : (
            <p className="text-sm text-on-surface-variant">
              {activeFilterCount || scoped ? "No rule matches for these filters." : "No rule matches yet."}
            </p>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant text-left text-xs uppercase tracking-wide text-on-surface-faint">
                  <th className="py-1.5 pr-3 font-medium">Outcome</th>
                  <th className="py-1.5 pr-3 font-medium">Tool</th>
                  <th className="py-1.5 pr-3 font-medium">Server</th>
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 font-medium"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision) => (
                  <tr key={decision.decisionId} className="border-b border-outline-variant/60">
                    <td className="py-1.5 pr-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={decision.enforced ? PILL_RED : PILL_GRAY}>
                          {EFFECT_LABELS[decision.outcome]}
                        </span>
                        {decision.enforced ? <span className={PILL_RED}>applied</span> : null}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 font-medium text-on-surface">{decision.toolName}</td>
                    <td className="py-1.5 pr-3 text-on-surface-faint">{decision.serverId ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-xs text-on-surface-faint">
                      {new Date(decision.createdAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 text-right">
                      <Button type="button" variant="ghost" size="sm" aria-label={`Details for ${decision.toolName}, ${new Date(decision.createdAt).toLocaleString()}`} onClick={() => setOpenId(decision.decisionId)}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination footer */}
        {total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-on-surface-faint">
            <span>
              Showing {rangeStart}–{rangeEnd} of {total}
              {pageCount > 1 ? ` · Page ${page + 1} of ${pageCount}` : null}
            </span>
            <span className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onPrev} disabled={page === 0 || fetching}>
                ‹ Prev
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onNext} disabled={!hasMore || fetching}>
                Next ›
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      <DecisionDetailDialog decisionId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}

const EVIDENCE_LABELS = { monitor_gateway: "Recorded in Monitor at the MCP gateway" } as const;

function DecisionScope({
  ref,
  filters,
  rules,
  total,
  onClear
}: {
  ref: React.Ref<HTMLDivElement>;
  filters: DecisionFilters;
  rules: PolicyRule[];
  total: number | null;
  onClear: () => void;
}) {
  const rule = filters.matchedRuleId ? rules.find((item) => item.ruleId === filters.matchedRuleId) : undefined;
  const windowText =
    filters.since && filters.until
      ? formatWindow(filters.since, filters.until)
      : filters.since
        ? `From ${formatUtc(filters.since)} UTC`
        : filters.until
          ? `Until ${formatUtc(filters.until)} UTC`
          : null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby="dec-scope-title"
      className="flex flex-col gap-3 rounded-lg border-l-2 border-l-primary bg-surface-container-low px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0 text-sm">
        <p id="dec-scope-title" className={SECTION_LABEL}>Scope</p>
        <dl className="mt-1.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          {filters.matchedRuleId ? (
            <>
              <dt className="text-on-surface-faint">Rule</dt>
              <dd className="text-on-surface [overflow-wrap:anywhere]">
                {rule ? rule.name : "Deleted or unknown rule"}
                <span className="ml-2 font-mono text-xs text-on-surface-faint">{filters.matchedRuleId}</span>
              </dd>
            </>
          ) : null}
          {filters.evidence ? (
            <>
              <dt className="text-on-surface-faint">Evidence</dt>
              <dd className="text-on-surface">{EVIDENCE_LABELS[filters.evidence]}</dd>
            </>
          ) : null}
          {windowText ? (
            <>
              <dt className="text-on-surface-faint">Window</dt>
              <dd className="text-on-surface">{windowText}</dd>
            </>
          ) : null}
        </dl>
        {total !== null ? (
          <p className="mt-1.5 text-xs text-on-surface-variant" aria-live="polite">
            {total === 1 ? "1 rule match in this scope." : `${total.toLocaleString()} rule matches in this scope.`}
          </p>
        ) : null}
      </div>
      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onClear}>
        Show all rule matches
      </Button>
    </div>
  );
}

function DecisionDetailDialog({
  decisionId,
  onClose
}: {
  decisionId: string | null;
  onClose: () => void;
}) {
  const { detail: view, loading, error } = useDecisionDetail(decisionId);

  return (
    <Dialog open={decisionId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rule match detail</DialogTitle>
          <DialogDescription>
            The evaluated action and its redacted snapshot, as recorded when the rule matched.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : view ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={view.enforced ? PILL_RED : PILL_GRAY}>{EFFECT_LABELS[view.outcome]}</span>
              {view.enforced ? <span className={PILL_RED}>applied</span> : null}
              {view.severity ? <span className={PILL_GRAY}>{SEVERITY_LABELS[view.severity]}</span> : null}
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-on-surface-variant">
              <Field label="Tool">{view.toolName}</Field>
              <Field label="Server">{view.serverId ?? "—"}</Field>
              <Field label="Category">{view.toolCategory ?? "—"}</Field>
              <Field label="Matched rule">{view.matchedRuleId ?? "— (default allow)"}</Field>
              <Field label="Session">{view.sessionId ?? "—"}</Field>
              <Field label="User">{view.userId ?? "—"}</Field>
              <Field label="Runtime">{view.runtimeId ?? "—"}</Field>
              <Field label="When">{new Date(view.createdAt).toLocaleString()}</Field>
            </dl>
            {view.explanation ? (
              <p className="rounded bg-surface-container p-2 text-on-surface-variant">{view.explanation}</p>
            ) : null}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-on-surface-faint">
                Action snapshot (redacted)
              </p>
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-surface-container p-2 font-mono text-xs text-on-surface-variant">
                {JSON.stringify(view.actionSnapshot, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-on-surface-faint">{label}</dt>
      <dd className="text-on-surface">{children}</dd>
    </>
  );
}
