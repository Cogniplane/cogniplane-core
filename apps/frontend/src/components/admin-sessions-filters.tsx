"use client";

import {
  activeFilterChips,
  ALERT_LABEL,
  dateInputToIso,
  dateRangeLabel,
  defaultLast7dRange,
  EMPTY_FILTER_STATE,
  filterStateToParams,
  isoToDateInput,
  presetRange,
  type SessionsFilterState
} from "./admin-sessions-filters.logic";
import type { AdminSessionAlertKind } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

export {
  activeFilterChips,
  ALERT_LABEL,
  dateInputToIso,
  dateRangeLabel,
  defaultLast7dRange,
  EMPTY_FILTER_STATE,
  filterStateToParams,
  isoToDateInput,
  presetRange,
  type SessionsFilterState
};

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_GRAY =
  "inline-flex items-center rounded-full bg-surface-container px-2 py-0.5 text-xs font-medium text-on-surface-variant";
const HINT = "text-sm text-on-surface-faint";

const STATUS_OPTIONS: Array<{ value: SessionsFilterState["status"] | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "errored", label: "Errored" }
];

const RUNTIME_OPTIONS: Array<{ value: SessionsFilterState["runtime"] | "all"; label: string }> = [
  { value: "all", label: "All runtimes" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" }
];

const ALERT_OPTIONS: Array<{ value: AdminSessionAlertKind | "all"; label: string }> = [
  { value: "all", label: "All alerts" },
  { value: "pii-blocked", label: "PII blocked" },
  { value: "pii-transformed", label: "PII transformed" },
  { value: "pii-detected", label: "PII detected" },
  { value: "approval-rejected", label: "Approval rejected" },
  { value: "approval-pending", label: "Approval pending" },
  { value: "errored", label: "Errored" }
];

export function AdminSessionsFilters(props: {
  state: SessionsFilterState;
  onChange: (next: SessionsFilterState) => void;
  onClear: () => void;
}) {
  const { state, onChange, onClear } = props;

  const apply = (patch: Partial<SessionsFilterState>) => onChange({ ...state, ...patch });

  const applyPreset = (days: number) => {
    apply(presetRange(days));
  };

  const chips = activeFilterChips(state);
  const alertSelectValue = state.alert.length === 1 ? state.alert[0] : "all";

  return (
    <Card>
      <CardContent className="pt-6">
        <details>
          <summary className="cursor-pointer list-revert">
            <div className="inline-flex w-[calc(100%-24px)] flex-wrap items-center justify-between gap-3 align-middle">
              <div>
                <p className={SECTION_LABEL}>Filters</p>
                <h2 className="text-lg font-semibold text-on-surface">Refine sessions</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {chips.length === 0 ? (
                    <span className={HINT}>No filters applied</span>
                  ) : (
                    chips.map((chip) => (
                      <span key={chip} className={PILL_GRAY}>
                        {chip}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
              >
                Clear filters
              </Button>
            </div>
          </summary>

          <div className="mt-3 mb-3 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(1)}>
              Last 24h
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(7)}>
              Last 7d
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(30)}>
              Last 30d
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-user">User</Label>
              <Input
                id="filter-user"
                type="text"
                placeholder="User ID"
                value={state.userId}
                onChange={(e) => apply({ userId: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-from">From</Label>
              <Input
                id="filter-from"
                type="date"
                value={isoToDateInput(state.from)}
                onChange={(e) => apply({ from: dateInputToIso(e.target.value, false) })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-to">To</Label>
              <Input
                id="filter-to"
                type="date"
                value={isoToDateInput(state.to)}
                onChange={(e) => apply({ to: dateInputToIso(e.target.value, true) })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-status">Status</Label>
              <Select
                value={state.status === "" ? "all" : state.status}
                onValueChange={(value) =>
                  apply({ status: value === "all" ? "" : (value as SessionsFilterState["status"]) })
                }
              >
                <SelectTrigger id="filter-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-runtime">Runtime</Label>
              <Select
                value={state.runtime === "" ? "all" : state.runtime}
                onValueChange={(value) =>
                  apply({
                    runtime:
                      value === "all" ? "" : (value as SessionsFilterState["runtime"])
                  })
                }
              >
                <SelectTrigger id="filter-runtime" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNTIME_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-alert">Alert</Label>
              <Select
                value={alertSelectValue}
                onValueChange={(value) => {
                  apply({
                    alert: value === "all" ? [] : [value as AdminSessionAlertKind]
                  });
                }}
                disabled={state.alert.length > 1}
              >
                <SelectTrigger id="filter-alert" className="w-full">
                  <SelectValue
                    placeholder={
                      state.alert.length > 1 ? `Multiple (${state.alert.length})` : undefined
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
