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
import { DisclosureRow } from "../overview-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

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
  // The result belongs to the submitted form, not to later edits.
  const [testedTurn, setTestedTurn] = useState<PolicyTurnContext | "any">("any");

  let status = "Check which rule matches a tool call. Nothing is recorded or blocked.";
  if (result) {
    status = result.matchedRuleName
      ? `${EFFECT_LABELS[result.outcome]}. Matched "${result.matchedRuleName}".`
      : "Allowed. No rule matched.";
    // The result does not depend on the mode, so say what each mode does with it.
    if (result.outcome === "block") status += " In Enforce, the call is blocked. In Monitor, it is only recorded.";
    if (result.outcome === "require_approval") {
      status += testedTurn === "scheduled"
        ? " In Enforce, the call is denied, because nobody can approve a scheduled run. In Monitor, it is only recorded."
        : testedTurn === "interactive"
          ? " In Enforce, the user must approve the call. In Monitor, it is only recorded."
          : " In Enforce, a chat asks the user to approve it and a scheduled run denies it. In Monitor, it is only recorded.";
    }
  }

  return (
    <DisclosureRow title="Test a tool call" action="Test" actionLabel="Test a tool call" status={<span role="status">{status}</span>}>
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
            onClick={() => {
              setTestedTurn(turnContext);
              onSimulate({
                toolName: toolName.trim(),
                category: category.trim() || null,
                severity: severity === "any" ? undefined : severity,
                serverId: category.trim() || null,
                turnContext: turnContext === "any" ? null : turnContext
              });
            }}
          >
            {simulating ? "Testing…" : "Run test"}
          </Button>
        </div>

        {result?.explanation ? <p className="text-sm text-on-surface-variant">{result.explanation}</p> : null}
    </DisclosureRow>
  );
}
