"use client";

import { useState } from "react";

import type {
  AdminRuntimeConfig,
  RuntimeSessionSummary
} from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import {
  countActiveSessions,
  filterRuntimeSessions,
  formatRuntimeTimestamp,
  type RuntimeStatusFilter
} from "./admin-runtime-card.logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PILL_GRAY, PILL_RED, PILL_GREEN, HINT, LIST_ITEM, SECTION_LABEL } from "../../../lib/ui-tokens";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";
const FILTER_CHIP =
  "inline-flex items-center rounded-full border border-outline-variant bg-transparent px-2.5 py-0.5 text-xs text-on-surface-variant transition-colors hover:bg-surface-container";
const FILTER_CHIP_ACTIVE =
  "inline-flex items-center rounded-full border border-accent bg-accent-soft px-2.5 py-0.5 text-xs text-accent";

const PAGE_SIZE = 20;

export function AdminRuntimeCard(props: {
  runtimeSessions: RuntimeSessionSummary[];
  runtimeConfig: AdminRuntimeConfig | null;
  busyKey: string | null;
  onDrainIdle: () => void;
  onRefreshIdle: () => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RuntimeStatusFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const activeCount = countActiveSessions(props.runtimeSessions);
  const filtered = filterRuntimeSessions(props.runtimeSessions, search, statusFilter);
  const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  // Drain and refresh share one request state in useAdminRuntimeData. Starting
  // one while the other runs would hide the first one's result, so a running
  // rollout blocks both.
  const rolloutRunning = props.busyKey !== null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Runtime fleet</p>
            <h2 className="text-lg font-semibold text-on-surface">
              Runtime sessions
            </h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              Inspect recent runtime sessions and refresh idle sessions when their configuration needs to be reloaded.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={PILL_GRAY}>{activeCount} active</span>
            <span className={PILL_GRAY}>{props.runtimeSessions.length} tracked</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {props.runtimeConfig ? (
          <details className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <summary className="cursor-pointer text-sm font-medium">Backend configuration</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={CHIP}>
                E2B template:{" "}
                <code className="ml-1 font-mono text-[0.7rem]">
                  {props.runtimeConfig.e2bTemplateId || "—"}
                </code>
              </span>
              {MODEL_PROVIDERS.map((provider) => {
                const configured = props.runtimeConfig!.platformProviders.includes(provider);
                return (
                  <span key={provider} className={configured ? PILL_GREEN : PILL_RED}>
                    {MODEL_PROVIDER_META[provider].label} key{" "}
                    {configured ? "set" : "missing"}
                  </span>
                );
              })}
            </div>
          </details>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rolloutRunning}
              onClick={() => props.onDrainIdle()}
            >
              {props.busyKey === "drain" ? "Draining..." : "Drain idle"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={rolloutRunning}
              onClick={() => props.onRefreshIdle()}
            >
              {props.busyKey === "refresh" ? "Refreshing..." : "Refresh idle"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="Filter by session or runtime ID"
            value={search}
            placeholder="Filter by session or runtime ID…"
            onChange={(e) => {
              setSearch(e.target.value);
              setShowAll(false);
            }}
            className="max-w-md flex-1"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "active", "stopped"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStatusFilter(s);
                  setShowAll(false);
                }}
                className={statusFilter === s ? FILTER_CHIP_ACTIVE : FILTER_CHIP}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {visible.length === 0 ? (
            <p className={HINT}>No sessions match the current filter.</p>
          ) : (
            visible.map((rs) => (
              <div className={LIST_ITEM} key={rs.runtimeId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-semibold text-on-surface">
                    {rs.sessionId}
                  </strong>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={PILL_GRAY}>{rs.status}</span>
                    <span
                      className={rs.healthStatus === "healthy" ? PILL_GREEN : PILL_RED}
                    >
                      {rs.healthStatus}
                    </span>
                    {rs.runtimeProvider ? (
                      <span className={PILL_GRAY}>{rs.runtimeProvider}</span>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 text-xs text-on-surface-faint">runtime {rs.runtimeId}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={CHIP}>
                    policy {rs.configSummary.runtimePolicy.id} v
                    {rs.configSummary.runtimePolicy.version}
                  </span>
                  <span className={CHIP}>
                    {rs.configSummary.skillVersions.length} skills pinned
                  </span>
                  <span className={CHIP}>
                    {rs.configSummary.mcpServerVersions.length} MCP servers pinned
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-on-surface-faint tabular-nums">
                  <span>Started {formatRuntimeTimestamp(rs.startedAt)}</span>
                  <span>Last active {formatRuntimeTimestamp(rs.lastActiveAt)}</span>
                  <span>Updated {formatRuntimeTimestamp(rs.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {filtered.length > PAGE_SIZE ? (
          <div className="border-t border-outline-variant pt-3 text-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? `Show fewer (${PAGE_SIZE} of ${filtered.length})`
                : `Show all ${filtered.length} sessions`}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
