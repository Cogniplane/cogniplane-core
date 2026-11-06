"use client";

import { useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, LoaderCircle } from "lucide-react";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { countActiveSessions, filterRuntimeSessions, formatRuntimeTimestamp, runtimeStatusBucket, type RuntimeStatusFilter } from "./admin-runtime-card.logic";
import type { useAdminRuntimeData } from "../../../hooks/use-admin-runtime-data";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PILL_GRAY, PILL_RED, PILL_GREEN, PILL_AMBER, HINT } from "../../../lib/ui-tokens";

const CHIP = "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";
const FILTER_CHIP = "inline-flex min-h-9 items-center rounded-md border border-input bg-control px-3 text-sm text-on-surface-variant transition-colors hover:bg-surface-container outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const FILTER_CHIP_ACTIVE = "inline-flex min-h-9 items-center rounded-md border border-brand-border bg-brand-surface px-3 text-sm font-medium text-brand-strong outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const FILTERS: [RuntimeStatusFilter, string][] = [["all", "All"], ["active", "Active"], ["terminated", "Terminated"], ["error", "Error"], ["other", "Other states"]];
const PAGE_SIZE = 20;

type RuntimeProps = ReturnType<typeof useAdminRuntimeData>;

export function AdminRuntimeCard(props: RuntimeProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RuntimeStatusFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [review, setReview] = useState<"drain" | "refresh" | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const activeCount = countActiveSessions(props.runtimeSessions);
  const filtered = filterRuntimeSessions(props.runtimeSessions, search, statusFilter);
  const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  const rolloutRunning = props.busyKey !== null;
  const resultCount = props.rolloutResult?.affectedSessionIds.length;

  function openReview(mode: "drain" | "refresh", trigger: HTMLButtonElement) {
    props.onPrepareRollout();
    opener.current = trigger;
    setReview(mode);
    requestAnimationFrame(() => {
      reviewHeading.current?.focus({ preventScroll: true });
      reviewHeading.current?.scrollIntoView({ block: "start" });
    });
  }

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-on-surface">Recent runtime records</h2>
          <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
            Up to 100 most recently updated records. Counts describe this list, not the live runtime fleet.
          </p>
        </div>
        <Button type="button" variant="outline" className="relative w-44" aria-disabled={props.sessionsRefreshing} aria-busy={props.sessionsRefreshing}
          onClick={() => { if (!props.sessionsRefreshing) props.onRetrySessions(); }}>
          {props.sessionsRefreshing ? <LoaderCircle className="absolute left-3 size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          Reload records
        </Button>
      </div>
      {props.sessionsLoaded ? <p className="flex flex-wrap gap-2" aria-label="Counts in the recent list">
        <span className={PILL_GRAY}>{props.runtimeSessions.length} recent {props.runtimeSessions.length === 1 ? "record" : "records"}</span>
        <span className={PILL_GRAY}>{activeCount} recorded active</span>
      </p> : null}
      {props.sessionsError ? <div role="alert" className="flex items-start gap-2 text-sm text-danger">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>{props.sessionsLoaded ? "Refresh failed. Showing the last loaded records. " : "Runtime records unavailable. "}{props.sessionsError} Use Reload records to try again.</p>
      </div> : null}
      {props.sessionsRefreshing ? <p role="status" className={HINT}>{props.sessionsLoaded ? "Refreshing runtime records…" : "Loading runtime records…"}</p> : null}
    </CardHeader>

    <CardContent className="flex flex-col gap-6">
      <details className="group border-y border-outline-variant py-3">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden="true" />Backend configuration
          {props.configError ? <span className={PILL_AMBER}>Read failed</span> : props.configLoading ? <span className={PILL_GRAY}>Loading</span> : null}
        </summary>
        <div className="mt-3 space-y-3">
          <p className="max-w-prose text-sm text-on-surface-variant">Platform key presence does not test provider health. An organization can use its own provider keys.</p>
          <Button type="button" variant="outline" aria-disabled={props.configRefreshing} aria-busy={props.configRefreshing}
            onClick={() => { if (!props.configRefreshing) props.onRetryConfig(); }}>Reload configuration</Button>
          {props.configRefreshing ? <p role="status" className={HINT}>Loading backend configuration…</p> : null}
          {props.configError ? <p role="alert" className="text-sm text-danger">{props.runtimeConfig ? "Showing the last loaded configuration. " : "Configuration unavailable. "}{props.configError}</p> : null}
          {props.runtimeConfig ? <>
            <p className="break-words text-sm text-on-surface-variant">Execution template: <code className="font-mono text-on-surface [overflow-wrap:anywhere]">{props.runtimeConfig.e2bTemplateId || "Not set"}</code></p>
            <ul className="flex flex-wrap gap-2" aria-label="Platform provider keys">
              {MODEL_PROVIDERS.map(provider => <li key={provider} className={PILL_GRAY}>
                {MODEL_PROVIDER_META[provider].label} platform key {props.runtimeConfig!.platformProviders.includes(provider) ? "set" : "not set"}
              </li>)}
            </ul>
          </> : !props.configLoading && !props.configError ? <p className={HINT}>No configuration was returned. Use Reload configuration to try again.</p> : null}
        </div>
      </details>

      <section aria-labelledby={`${id}-actions`} className="space-y-3">
        <h3 id={`${id}-actions`} className="text-base font-semibold">Idle runtime actions</h3>
        <p className="max-w-prose text-sm text-on-surface-variant">Drain idle and Refresh idle currently do the same reset. Review the workspace consequences before you continue.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={rolloutRunning} onClick={event => openReview("drain", event.currentTarget)}>Drain idle</Button>
          <Button type="button" variant="outline" disabled={rolloutRunning} onClick={event => openReview("refresh", event.currentTarget)}>Refresh idle</Button>
        </div>
        {review ? <div className="rounded-lg bg-warning-surface p-4 text-sm text-on-surface">
          <h4 ref={reviewHeading} tabIndex={-1} className="scroll-mt-2 rounded-sm font-semibold outline-none focus:ring-[3px] focus:ring-ring/50">
            Review {review === "drain" ? "Drain idle" : "Refresh idle"}
          </h4>
          <p className="mt-2 max-w-prose">This resets idle execution workspaces across your organization, including runtimes outside this recent list. Files created in those workspaces must be recreated. Saved conversations remain. Active turns are skipped. The next turn rebuilds the workspace with current configuration.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={rolloutRunning} onClick={() => {
              setReview(null); props.onPrepareRollout(); opener.current?.focus();
            }}>Close review</Button>
            <Button type="button" variant="destructive" aria-disabled={rolloutRunning} aria-busy={rolloutRunning}
              aria-describedby={props.rolloutError || props.rolloutResult ? `${id}-result` : undefined}
              onClick={() => { if (!rolloutRunning) (review === "drain" ? props.onDrainIdle : props.onRefreshIdle)(); }}>
              Reset idle workspaces
            </Button>
          </div>
          {rolloutRunning ? <p role="status" className="mt-3 flex items-center gap-2"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Resetting idle workspaces…</p> : null}
          {props.rolloutError ? <p id={`${id}-result`} role="alert" className="mt-3 flex items-start gap-2 text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{props.rolloutError}</p> : null}
          {props.rolloutResult ? <p id={`${id}-result`} role="status" className="mt-3 flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            {resultCount === 0 ? "No idle runtimes were reset. No sessions were affected." : `Reset idle workspaces for ${resultCount} ${resultCount === 1 ? "session" : "sessions"}.`}
          </p> : null}
        </div> : null}
      </section>

      {props.sessionsLoaded ? <section aria-label="Recent runtime records" className="space-y-4 border-t border-outline-variant pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <Input type="search" aria-label="Filter by session or runtime ID" value={search} placeholder="Session or runtime ID…"
            onChange={event => { setSearch(event.target.value); setShowAll(false); }} className="min-w-0 flex-1 basis-64" />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Recorded lifecycle state">
            {FILTERS.map(([state, label]) => <button key={state} type="button" aria-pressed={statusFilter === state}
              className={statusFilter === state ? FILTER_CHIP_ACTIVE : FILTER_CHIP}
              onClick={() => { setStatusFilter(state); setShowAll(false); }}>{label}</button>)}
          </div>
        </div>
        <p className={HINT}>Health is the last report on each record, not a live check. Times use your browser&apos;s time zone.</p>
        {visible.length === 0 ? <p className="py-4 text-sm text-on-surface-variant">
          {props.runtimeSessions.length === 0 ? "No recent runtime records were returned." : "No records match these filters. Try another ID or select All."}
        </p> : <ul className="divide-y divide-outline-variant">
          {visible.map(rs => <li className="min-w-0 py-4 first:pt-0" key={rs.runtimeId}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <strong className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{rs.sessionId}</strong>
              <div className="flex flex-wrap gap-1.5">
                <span className={runtimeStatusBucket(rs.status) === "error" ? PILL_RED : PILL_GRAY}>
                  {runtimeStatusBucket(rs.status) === "other" ? `Other state: ${rs.status || "Unknown"}` : rs.status}
                </span>
                <span className={rs.healthStatus === "healthy" ? PILL_GREEN : rs.healthStatus === "error" ? PILL_RED : PILL_GRAY}>Last health: {rs.healthStatus || "Unknown"}</span>
                {rs.runtimeProvider ? <span className={PILL_GRAY}>{rs.runtimeProvider}</span> : null}
              </div>
            </div>
            <p className="mt-1 text-xs text-on-surface-variant [overflow-wrap:anywhere]">Runtime {rs.runtimeId}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className={`${CHIP} [overflow-wrap:anywhere]`}>Policy {rs.configSummary.runtimePolicy.id} v{rs.configSummary.runtimePolicy.version}</span>
              <span className={CHIP}>{rs.configSummary.skillVersions.length} {rs.configSummary.skillVersions.length === 1 ? "skill" : "skills"} pinned</span>
              <span className={CHIP}>{rs.configSummary.mcpServerVersions.length} MCP {rs.configSummary.mcpServerVersions.length === 1 ? "server" : "servers"} pinned</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-on-surface-variant tabular-nums">
              <span>Started {formatRuntimeTimestamp(rs.startedAt)}</span><span>Last active {formatRuntimeTimestamp(rs.lastActiveAt)}</span><span>Updated {formatRuntimeTimestamp(rs.updatedAt)}</span>
            </div>
          </li>)}
        </ul>}
        {filtered.length > PAGE_SIZE ? <Button type="button" variant="outline" onClick={() => setShowAll(value => !value)}>
          {showAll ? `Show fewer (${PAGE_SIZE} of ${filtered.length})` : `Show all ${filtered.length} records`}
        </Button> : null}
      </section> : null}
    </CardContent>
  </Card>;
}
