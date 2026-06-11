"use client";

import { useState } from "react";

import type { PolicyDecision, PolicyEffect, PolicySeverity } from "@cogniplane/shared-types";

import {
  ALL_EFFECTS,
  ALL_SEVERITIES,
  decisionFiltersFromDraft,
  EFFECT_LABELS,
  SEVERITY_LABELS
} from "./admin-policy-form.logic";
import { useDecisionDetail, type DecisionFilters } from "../../../hooks/use-policy-data";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { PILL_GRAY, PILL_RED } from "../../../lib/ui-tokens";

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

  const [openId, setOpenId] = useState<string | null>(null);

  const applyDraft = () => {
    onApply(decisionFiltersFromDraft({ outcome, enforced, severity, toolText, from, to }));
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
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
        <CardDescription>
          Policy evidence for evaluated MCP tool actions. Recorded-only rows are observations;
          applied rows changed, paused, or blocked the action. (Runtime shell/file approvals are
          tracked separately and do not appear here.)
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Filter bar */}
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
            <Input id="dec-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-to">To</Label>
            <Input id="dec-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={applyDraft} disabled={fetching}>
            Apply filters
          </Button>
          <Button type="button" variant="outline" onClick={clearDraft} disabled={fetching}>
            Clear
          </Button>
          <Button type="button" variant="ghost" onClick={onRefresh} disabled={fetching}>
            Refresh
          </Button>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {/* Table */}
        {loading ? (
          <p className="text-sm text-on-surface-faint">Loading decisions…</p>
        ) : decisions.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            No decisions match. Decisions appear here once a rule matches an agent action.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant text-left text-xs uppercase tracking-wide text-on-surface-faint">
                  <th className="py-1.5 pr-3 font-medium">Outcome</th>
                  <th className="py-1.5 pr-3 font-medium">Tool</th>
                  <th className="py-1.5 pr-3 font-medium">Server</th>
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision) => (
                  <tr
                    key={decision.decisionId}
                    className="cursor-pointer border-b border-outline-variant/60 hover:bg-surface-container-lowest"
                    onClick={() => setOpenId(decision.decisionId)}
                  >
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
                    {/* The whole row is the click target (opens the detail
                        dialog); this cell is just the visible affordance. */}
                    <td className="py-1.5 text-right text-xs text-primary">Details →</td>
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
      </CardContent>

      <DecisionDetailDialog decisionId={openId} onClose={() => setOpenId(null)} />
    </Card>
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
          <DialogTitle>Decision detail</DialogTitle>
          <DialogDescription>
            The evaluated action and its redacted snapshot, as recorded at decision time.
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
