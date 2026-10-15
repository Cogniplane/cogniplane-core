"use client";
// CopilotKit renderers for the tool call card and the plan. They run inside
// the CopilotKit provider. Custom event cards are owned by useAguiCustomEvents.

import { UseAgentUpdate, useAgent, useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { createContext, useContext, useState } from "react";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";

import { PlanRowView } from "./chat-cards/plan-row";

/** A tool call that did not complete normally. A failed or declined call
 *  comes from a `tool_status` event or saved history. An interrupted call
 *  comes from saved history: the turn stopped before the call returned. */
export type ToolOutcome = "failed" | "declined" | "interrupted";

/** Outcomes by tool call ID. The chat message list provides them. */
export const ToolOutcomeContext = createContext<ReadonlyMap<string, ToolOutcome>>(new Map());

type ToolStatus = "inProgress" | "executing" | "complete";

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  failed: "failed",
  declined: "declined",
  interrupted: "interrupted"
};

export function ToolCard({
  name,
  parameters,
  status,
  result,
  outcome
}: {
  name: string;
  parameters: unknown;
  status: ToolStatus;
  result: unknown;
  outcome?: ToolOutcome;
}) {
  const [open, setOpen] = useState(false);
  const running = status !== "complete" && !outcome;
  const argsText = stringify(parameters);
  const resultText = stringify(result);
  const label = outcome ? OUTCOME_LABEL[outcome] : running ? "running…" : "done";
  const dot = outcome ? "bg-danger" : running ? "animate-pulse bg-brand" : "bg-success";

  return (
    <article className="card-enter rounded-md border border-outline-variant bg-surface-container-low px-3 py-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
      >
        <ChevronDownIcon className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        <WrenchIcon className="size-4 shrink-0 text-on-surface-faint" />
        <span className="font-mono font-medium text-on-surface">{name}</span>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-xs ${
            outcome ? "text-danger" : running ? "text-brand" : "text-on-surface-faint"
          }`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
          {label}
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {argsText ? (
            <pre className="overflow-x-auto rounded bg-surface-container px-2 py-1 font-mono text-xs text-on-surface-variant">
              {argsText}
            </pre>
          ) : null}
          {resultText ? (
            <pre className="overflow-x-auto rounded bg-surface-container px-2 py-1 font-mono text-xs text-on-surface-variant">
              {resultText}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ToolCallCard(props: { name: string; toolCallId: string; parameters: unknown; status: ToolStatus; result: unknown }) {
  const outcome = useContext(ToolOutcomeContext).get(props.toolCallId);
  return <ToolCard name={props.name} parameters={props.parameters} status={props.status} result={props.result} outcome={outcome} />;
}

/** Registers the card for every tool call. CopilotKit renders a tool call
 *  without a registered renderer as nothing. */
export function CopilotRenderSlots() {
  useDefaultRenderTool({
    render: ({ name, toolCallId, parameters, status, result }) => (
      <ToolCallCard name={name} toolCallId={toolCallId} parameters={parameters} status={status} result={result} />
    )
  });
  return null;
}

const STATE_UPDATES = [UseAgentUpdate.OnStateChanged];

/** The agent's plan (`write_todos`). It is agent state at `/plan`: the
 *  session connection restores it, and STATE_DELTA events change it live. */
export function AgentPlan({ agentId }: { agentId: string }) {
  const { agent } = useAgent({ agentId, updates: STATE_UPDATES });
  const plan = (agent.state as { plan?: unknown } | undefined)?.plan;
  const text = typeof plan === "string" ? plan.trim() : "";
  return text ? <PlanRowView row={{ type: "plan", rowId: "plan", messageId: "plan", text }} /> : null;
}
