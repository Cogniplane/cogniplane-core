"use client";
// CopilotKit renderers for the tool call card and the plan. They run inside
// the CopilotKit provider. Custom event cards are owned by useAguiCustomEvents.

import { UseAgentUpdate, useAgent, useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { createContext, useContext, useId, useRef, useState } from "react";
import {
  ChevronDownIcon,
  FileTextIcon,
  FolderIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon
} from "lucide-react";

import { InlineApproval } from "./chat-cards/approval-row";
import type { ApprovalDecision, ApprovalRow } from "./chat-cards/chat-cards.types";
import { PlanRowView } from "./chat-cards/plan-row";
import { useCardApproval } from "./chat-cards/tool-approvals";
import { describeToolCall, previewResult, resultText, type ToolIcon } from "./tool-activity.logic";

/** A tool call that did not complete normally. A failed or declined call
 *  comes from a `tool_status` event or saved history. An interrupted call
 *  comes from saved history: the turn stopped before the call returned. */
export type ToolOutcome = "failed" | "declined" | "interrupted";

/** Outcomes by tool call ID. The chat message list provides them. */
export const ToolOutcomeContext = createContext<ReadonlyMap<string, ToolOutcome>>(new Map());

/** True when the history is shown and no turn runs, in this tab or on the
 *  server. A call that has no result then did not return, whatever the saved
 *  rows say yet. The chat message list provides it. */
export const ToolTurnSettledContext = createContext(false);

type ToolStatus = "inProgress" | "executing" | "complete";

const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  failed: "failed",
  declined: "declined",
  interrupted: "interrupted"
};

/** An interrupted call has no result. Its action may still be running, so the
 *  card does not say that the action failed or stopped. */
const INTERRUPTED_NOTE =
  "The turn stopped before this tool gave a result. The action can be done, partly done, or not started. Check before you repeat it.";

const ICONS: Record<ToolIcon, LucideIcon> = {
  file: FileTextIcon,
  folder: FolderIcon,
  command: TerminalIcon,
  search: SearchIcon,
  tool: WrenchIcon
};

const BLOCK = "rounded bg-surface-container px-2 py-1 font-mono text-xs text-on-surface-variant";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Text that scrolls inside its own box, so it never widens the page. The box
 *  takes focus, so a keyboard can scroll it. */
function ScrollText({ label, text, maxHeight }: { label: string; text: string; maxHeight: string }) {
  return (
    <div role="group" aria-label={label} tabIndex={0} className={`${maxHeight} overflow-auto ${BLOCK} ${FOCUS}`}>
      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
    </div>
  );
}

function RawBlock({ label, text }: { label: string; text: string | null }) {
  if (text === null) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-on-surface-variant">{label}</p>
      {text === "" ? (
        <p className="text-xs text-on-surface-faint">Empty.</p>
      ) : (
        <ScrollText label={label} text={text} maxHeight="max-h-64" />
      )}
    </div>
  );
}

/** The result that the card shows without a click: the output of a tool that
 *  returns plain text, and the message of a call that did not complete. */
function CardResult({ label, result, error }: { label: string; result: unknown; error: boolean }) {
  const preview = previewResult(result);
  if (!preview) return null;
  if (preview.text === "") {
    return error ? <p className="mt-2 text-xs text-on-surface-variant">The tool gave no message.</p>
      : <p className="mt-2 text-xs text-on-surface-faint">No output.</p>;
  }
  return (
    <div className="mt-2">
      <ScrollText label={label} text={preview.text} maxHeight="max-h-36" />
      {preview.hidden > 0 ? (
        <p className="mt-1 text-xs text-on-surface-faint">
          Showing the first part of this result. Open the card to see all of it.
        </p>
      ) : null}
    </div>
  );
}

export function ToolCard({
  name,
  parameters,
  status,
  result,
  outcome,
  approval
}: {
  name: string;
  parameters: unknown;
  status: ToolStatus;
  result: unknown;
  outcome?: ToolOutcome;
  /** A pending approval of this call. The card shows its decision controls. */
  approval?: { row: ApprovalRow; onDecision: (approvalId: string, decision: ApprovalDecision) => void } | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const toggle = useRef<HTMLButtonElement | null>(null);
  // A call that waits for a decision has not started yet.
  const waiting = Boolean(approval) && !outcome;
  const running = status !== "complete" && !outcome && !waiting;
  const activity = describeToolCall(name, parameters);
  const Icon = ICONS[activity.icon];
  const label = outcome ? OUTCOME_LABEL[outcome] : waiting ? "needs approval" : running ? "running…" : "done";
  const dot = outcome ? "bg-danger" : waiting ? "bg-warning" : running ? "animate-pulse bg-brand" : "bg-success";
  const tone = outcome ? "text-danger" : waiting ? "text-warning" : running ? "text-brand" : "text-on-surface-faint";
  // A result that the call returned. A call that is still running has none.
  const hasResult = result !== undefined && result !== null;
  const failed = outcome === "failed" || outcome === "declined";
  // The open details hold the whole result, so the preview steps aside.
  const showResult = !open && hasResult && (outcome === "failed" || outcome === "declined" || (!outcome && activity.readableResult));

  return (
    <article className={`card-enter rounded-md border px-3 py-2 text-sm ${failed ? "border-danger/30 bg-danger-surface" : "border-outline-variant bg-surface-container-low"}`}>
      <button
        ref={toggle}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 text-left ${FOCUS}`}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
      >
        <ChevronDownIcon className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon className="size-4 shrink-0 text-on-surface-faint" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={`font-medium text-on-surface ${activity.target ? "max-w-[55%] shrink-0 truncate" : "min-w-0 truncate"}`}>
            {activity.label}
          </span>
          {activity.target ? (
            <span className="min-w-0 truncate font-mono text-xs text-on-surface-variant">{activity.target}</span>
          ) : null}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${tone}`}>
          <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
          {label}
        </span>
      </button>
      {approval && waiting ? (
        <InlineApproval row={approval.row} onDecision={approval.onDecision} onSettled={() => toggle.current?.focus()} />
      ) : null}
      {showResult ? (
        <CardResult label={`Result of ${activity.label}`} result={result} error={outcome === "failed" || outcome === "declined"} />
      ) : null}
      {outcome === "interrupted" ? <p className="mt-2 text-xs text-on-surface-variant">{INTERRUPTED_NOTE}</p> : null}
      {open ? (
        <div id={detailsId} className="mt-2 space-y-2 border-t border-outline-variant pt-2">
          <p className="text-xs text-on-surface-variant">
            Tool <span className="font-mono text-on-surface [overflow-wrap:anywhere]">{name}</span>
          </p>
          <RawBlock label="Input" text={resultText(parameters)} />
          <RawBlock label="Result" text={resultText(result)} />
        </div>
      ) : null}
    </article>
  );
}

function ToolCallCard(props: { name: string; toolCallId: string; parameters: unknown; status: ToolStatus; result: unknown }) {
  const recorded = useContext(ToolOutcomeContext).get(props.toolCallId);
  const settled = useContext(ToolTurnSettledContext);
  // A call without a result, in a chat where nothing runs, did not return.
  const outcome = recorded ?? (settled && props.status !== "complete" ? "interrupted" : undefined);
  const approval = useCardApproval(props.toolCallId, !outcome && props.status !== "complete");
  return <ToolCard name={props.name} parameters={props.parameters} status={props.status} result={props.result} outcome={outcome}
    approval={approval} />;
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
