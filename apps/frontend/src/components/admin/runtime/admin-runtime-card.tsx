"use client";

import { useState } from "react";

import type {
  AdminRuntimeConfig,
  RuntimeOpenAiDiagnostic,
  RuntimeSessionSummary
} from "@cogniplane/shared-types";
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
  runtimeDiagnostic: RuntimeOpenAiDiagnostic | null;
  busyKey: string | null;
  onDrainIdle: () => void;
  onRefreshIdle: () => void;
  onRunRuntimeDiagnostic: () => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RuntimeStatusFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const activeCount = countActiveSessions(props.runtimeSessions);
  const filtered = filterRuntimeSessions(props.runtimeSessions, search, statusFilter);
  const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Runtime fleet</p>
            <h2 className="text-lg font-semibold text-on-surface">
              Rollout and session health
            </h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              Watch which config bundle is loaded by live runtimes and control idle refresh or
              drain operations without leaving the admin plane.
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
          <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <p className={SECTION_LABEL}>Backend configuration</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={CHIP}>
                E2B template:{" "}
                <code className="ml-1 font-mono text-[0.7rem]">
                  {props.runtimeConfig.e2bTemplateId || "—"}
                </code>
              </span>
              <span
                className={props.runtimeConfig.openaiKeyConfigured ? PILL_GREEN : PILL_RED}
              >
                OpenAI key {props.runtimeConfig.openaiKeyConfigured ? "set" : "missing"}
              </span>
              <span
                className={props.runtimeConfig.anthropicKeyConfigured ? PILL_GREEN : PILL_RED}
              >
                Anthropic key{" "}
                {props.runtimeConfig.anthropicKeyConfigured ? "set" : "missing"}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={CHIP}>rollout aware</span>
            <span className={CHIP}>config hashes visible</span>
            <span className={CHIP}>idle controls</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.busyKey === "runtime-diagnostic"}
              onClick={() => props.onRunRuntimeDiagnostic()}
            >
              {props.busyKey === "runtime-diagnostic"
                ? "Running diagnostic..."
                : "Run OpenAI diagnostic"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.busyKey === "drain"}
              onClick={() => props.onDrainIdle()}
            >
              {props.busyKey === "drain" ? "Draining..." : "Drain idle"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={props.busyKey === "refresh"}
              onClick={() => props.onRefreshIdle()}
            >
              {props.busyKey === "refresh" ? "Refreshing..." : "Refresh idle"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm font-semibold text-on-surface">
              Container OpenAI diagnostic
            </strong>
            {props.runtimeDiagnostic ? (
              <span className="text-xs text-on-surface-faint">
                Last checked {formatRuntimeTimestamp(props.runtimeDiagnostic.checkedAt)}
              </span>
            ) : (
              <span className="text-xs text-on-surface-faint">
                Run this from the admin UI to avoid manual bearer-token calls.
              </span>
            )}
          </div>
          {props.runtimeDiagnostic ? (
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-surface-container px-3 py-2 text-[11px]">
              {JSON.stringify(props.runtimeDiagnostic, null, 2)}
            </pre>
          ) : (
            <p className={`${HINT} mt-2`}>
              Checks DNS, model reachability, and direct `/v1/responses` calls from the container.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
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
                    {rs.mode ? (
                      <span
                        className={PILL_GRAY}
                        title={
                          rs.mode === "e2b"
                            ? "Claude SDK ran inside the E2B sandbox via the sandbox-agent harness."
                            : "Claude SDK ran in-process on the backend."
                        }
                      >
                        mode: {rs.mode}
                      </span>
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
