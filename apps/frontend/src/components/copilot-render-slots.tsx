"use client";
// CopilotKit hooks register the tool cards and plan renderer inside its provider.
// Custom event cards are owned by useAguiCustomEvents.

import { useCoAgentStateRender, useDefaultTool } from "@copilotkit/react-core";
import { useState } from "react";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";

import { PlanRowView } from "./chat-cards/plan-row";

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolCard({
  name,
  args,
  status,
  result
}: {
  name: string;
  args: unknown;
  status: "inProgress" | "executing" | "complete";
  result: unknown;
}) {
  const [open, setOpen] = useState(false);
  const running = status !== "complete";
  const argsText = stringify(args);
  const resultText = stringify(result);

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
            running ? "text-brand" : "text-on-surface-faint"
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${running ? "animate-pulse bg-brand" : "bg-success"}`}
          />
          {running ? "running…" : "done"}
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

export function CopilotRenderSlots({ agentName }: { agentName: string }) {
  useDefaultTool({
    render: ({ name, args, status, result }) => (
      <ToolCard name={name} args={args} status={status} result={result} />
    )
  });

  useCoAgentStateRender({
    name: agentName,
    render: ({ state }) => {
      const plan = (state as { plan?: string } | undefined)?.plan?.trim();
      return plan
        ? <PlanRowView row={{ type: "plan", rowId: "plan", messageId: "plan", text: plan }} />
        : null;
    }
  });

  return null;
}
