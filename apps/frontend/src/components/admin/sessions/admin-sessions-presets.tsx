"use client";

import {
  EMPTY_FILTER_STATE,
  type SessionsFilterState
} from "./admin-sessions-filters.logic";
import type { AdminSessionAlertKind } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

type PresetId = "pii-incidents" | "approvals-pending" | "errored";

type Preset = {
  id: PresetId;
  label: string;
  build: () => SessionsFilterState;
  matches: (state: SessionsFilterState) => boolean;
};

function rangeDays(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

function alertSetEqual(actual: AdminSessionAlertKind[], expected: AdminSessionAlertKind[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((k) => expectedSet.has(k));
}

const PII_INCIDENT_KINDS: AdminSessionAlertKind[] = [
  "pii-blocked",
  "pii-transformed",
  "pii-detected"
];

const PRESETS: Preset[] = [
  {
    id: "pii-incidents",
    label: "PII incidents",
    build: () => ({
      ...EMPTY_FILTER_STATE,
      ...rangeDays(30),
      alert: [...PII_INCIDENT_KINDS]
    }),
    matches: (state) => alertSetEqual(state.alert, PII_INCIDENT_KINDS) && state.status === ""
  },
  {
    id: "approvals-pending",
    label: "Approvals pending",
    build: () => ({
      ...EMPTY_FILTER_STATE,
      ...rangeDays(7),
      alert: ["approval-pending"],
      status: "active"
    }),
    matches: (state) =>
      alertSetEqual(state.alert, ["approval-pending"]) && state.status === "active"
  },
  {
    id: "errored",
    label: "Errored sessions",
    build: () => ({
      ...EMPTY_FILTER_STATE,
      ...rangeDays(7),
      alert: ["errored"]
    }),
    matches: (state) => alertSetEqual(state.alert, ["errored"]) && state.status === ""
  }
];

export function AdminSessionsPresets(props: {
  state: SessionsFilterState;
  onApply: (next: SessionsFilterState) => void;
}) {
  const activeId = PRESETS.find((p) => p.matches(props.state))?.id ?? null;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Saved views</p>
            <h2 className="text-lg font-semibold text-on-surface">Quick filters</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={activeId === preset.id ? "default" : "outline"}
                size="sm"
                onClick={() => props.onApply(preset.build())}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
