"use client";

import { useRef, useState } from "react";

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
  error?: string | null;
  onInputChange?: () => void;
  onSimulate: (input: {
    toolName: string;
    category: string | null;
    severity?: PolicySeverity;
    serverId: string | null;
    turnContext?: PolicyTurnContext | null;
  }) => void | Promise<void>;
};

export function AdminPolicySimulator({ result, simulating, onSimulate, error, onInputChange }: Props) {
  const [toolName, setToolName] = useState("");
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState<PolicySeverity | "any">("any");
  const [turnContext, setTurnContext] = useState<PolicyTurnContext | "any">("any");
  // The result belongs to the submitted form, not to later edits.
  const [testedTurn, setTestedTurn] = useState<PolicyTurnContext | "any">("any");

  const runLock = useRef(false);
  const runSequence = useRef(0);
  const [edited, setEdited] = useState(false);
  const [testedInput, setTestedInput] = useState<string | null>(null);
  function inputChanged() {
    runSequence.current++;
    runLock.current = false;
    setEdited(true);
    onInputChange?.();
  }
  const currentResult = edited || simulating || error ? null : result;
  let status = "Check which rule matches a tool call. Nothing is recorded or blocked.";
  if (currentResult) {
    status = currentResult.matchedRuleName
      ? `${EFFECT_LABELS[currentResult.outcome]}. Matched "${currentResult.matchedRuleName}".`
      : "Allowed. No rule matched.";
    // The result does not depend on the mode, so say what each mode does with it.
    if (currentResult.outcome === "block") status += " In Enforce, the call is blocked. In Monitor, it is only recorded.";
    if (currentResult.outcome === "require_approval") {
      status += testedTurn === "scheduled"
        ? " In Enforce, the call is denied, because nobody can approve a scheduled run. In Monitor, it is only recorded."
        : testedTurn === "interactive"
          ? " In Enforce, the user must approve the call. In Monitor, it is only recorded."
          : " In Enforce, a chat asks the user to approve it and a scheduled run denies it. In Monitor, it is only recorded.";
    }
  }

  if (simulating) status = "Testing the submitted tool call...";
  else if (error && !edited) status = "Test failed. This call has no test result.";
  else if (edited) status = "Inputs changed. Run a test for this tool call.";

  return (
    <DisclosureRow title="Test a tool call" action="Test" actionLabel="Test a tool call" status={<span role="status">{status}</span>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-tool">Tool name</Label>
            <Input
              id="sim-tool"
              value={toolName}
              onChange={(e) => { setToolName(e.target.value); inputChanged(); }}
              placeholder="github_write_file"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-category">Category / server</Label>
            <Input
              id="sim-category"
              value={category}
              onChange={(e) => { setCategory(e.target.value); inputChanged(); }}
              placeholder="github"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-severity">Severity</Label>
            <Select value={severity} onValueChange={(v) => { setSeverity(v as PolicySeverity | "any"); inputChanged(); }}>
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
            <Select value={turnContext} onValueChange={(v) => { setTurnContext(v as PolicyTurnContext | "any"); inputChanged(); }}>
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
            disabled={toolName.trim().length === 0}
            aria-disabled={simulating || toolName.trim().length === 0}
            aria-busy={simulating}
            onClick={async () => {
              if (simulating || runLock.current || !toolName.trim()) return;
              runLock.current = true;
              const sequence = ++runSequence.current;
              setEdited(false);
              setTestedTurn(turnContext);
              setTestedInput(`${toolName.trim()} · ${category.trim() || "any category"} · ${severity} severity · ${turnContext} turn`);
              try { await onSimulate({
                toolName: toolName.trim(),
                category: category.trim() || null,
                severity: severity === "any" ? undefined : severity,
                serverId: category.trim() || null,
                turnContext: turnContext === "any" ? null : turnContext
              }); } finally { if (sequence === runSequence.current) runLock.current = false; }
            }}
          >
            {simulating ? "Testing…" : error && !edited ? "Retry test" : "Run test"}
          </Button>
        </div>

        {testedInput && !edited ? <p className="break-words text-sm text-on-surface-variant">Tested input: {testedInput}</p> : null}
        {error && !edited ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {currentResult?.explanation ? <p className="text-sm text-on-surface-variant">{currentResult.explanation}</p> : null}
    </DisclosureRow>
  );
}
