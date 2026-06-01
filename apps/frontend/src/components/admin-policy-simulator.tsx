"use client";

import { useState } from "react";

import type {
  PolicySeverity,
  PolicySimulateResponse,
  PolicyTurnContext
} from "@cogniplane/shared-types";

import {
  ALL_SEVERITIES,
  ALL_TURN_CONTEXTS,
  EFFECT_LABELS,
  SEVERITY_LABELS,
  TURN_CONTEXT_LABELS
} from "./admin-policy-form.logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;

type Props = {
  result: PolicySimulateResponse | null;
  simulating: boolean;
  onSimulate: (input: {
    toolName: string;
    category: string | null;
    severity?: PolicySeverity;
    serverId: string | null;
    turnContext?: PolicyTurnContext | null;
  }) => void;
};

export function AdminPolicySimulator({ result, simulating, onSimulate }: Props) {
  const [toolName, setToolName] = useState("");
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState<PolicySeverity | "any">("any");
  const [turnContext, setTurnContext] = useState<PolicyTurnContext | "any">("any");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulator</CardTitle>
        <CardDescription>
          Evaluate a hypothetical action against the active rules without recording or gating
          anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-tool">Tool name</Label>
            <Input
              id="sim-tool"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="github_write_file"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-category">Category / server</Label>
            <Input
              id="sim-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="github"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-severity">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as PolicySeverity | "any")}>
              <SelectTrigger id="sim-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {ALL_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SEVERITY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-turn">Turn context</Label>
            <Select value={turnContext} onValueChange={(v) => setTurnContext(v as PolicyTurnContext | "any")}>
              <SelectTrigger id="sim-turn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {ALL_TURN_CONTEXTS.map((tc) => (
                  <SelectItem key={tc} value={tc}>
                    {TURN_CONTEXT_LABELS[tc]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Button
            type="button"
            disabled={simulating || toolName.trim().length === 0}
            onClick={() =>
              onSimulate({
                toolName: toolName.trim(),
                category: category.trim() || null,
                severity: severity === "any" ? undefined : severity,
                serverId: category.trim() || null,
                turnContext: turnContext === "any" ? null : turnContext
              })
            }
          >
            {simulating ? "Evaluating…" : "Simulate"}
          </Button>
        </div>

        {result ? (
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={result.outcome === "block" ? PILL_RED : PILL_GRAY}>
                {EFFECT_LABELS[result.outcome]}
              </span>
              {result.enforced ? (
                <span className={PILL_RED}>would gate</span>
              ) : (
                <span className={PILL_GREEN}>would proceed</span>
              )}
              {result.matchedRuleName ? (
                <span className="text-xs text-on-surface-faint">
                  matched: {result.matchedRuleName}
                </span>
              ) : (
                <span className="text-xs text-on-surface-faint">no rule matched (default allow)</span>
              )}
            </div>
            {result.explanation ? (
              <p className="mt-1 text-sm text-on-surface-variant">{result.explanation}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
