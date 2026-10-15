import { useId, useState, type ReactNode, type Ref } from "react";

import { Button } from "@/components/ui/button";

/** One Overview line: a name, one status line, and its actions. */
export function OverviewRow({ title, status, busy, children }: { title: ReactNode; status: ReactNode; busy?: boolean; children: ReactNode }) {
  return <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0">
      <h3 className="flex flex-wrap items-center gap-2 font-medium">{title}</h3>
      <p className="mt-1 text-sm text-on-surface-variant" role={busy ? "status" : undefined}>{status}</p>
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-3 sm:max-w-[60%] sm:justify-end">{children}</div>
  </div>;
}

/** An Overview line whose button opens its editor below. The panel stays mounted when closed, so its draft edits survive. */
export function DisclosureRow({ title, status, action, actionLabel, actions, open: controlledOpen, onOpenChange, buttonRef, disabled, children }: {
  title: ReactNode;
  status: ReactNode;
  action: string;
  /** Accessible name when the action text repeats across rows. It must start with the visible text. */
  actionLabel?: string;
  /** Other controls, before the button. */
  actions?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const panelId = useId();
  return <div>
    <OverviewRow title={title} status={status}>
      {actions}
      <Button ref={buttonRef} type="button" variant="outline" size="sm" aria-label={actionLabel} aria-expanded={open} aria-controls={panelId} disabled={disabled}
        onClick={() => { if (controlledOpen === undefined) setLocalOpen(!open); onOpenChange?.(!open); }}>{action}</Button>
    </OverviewRow>
    <div id={panelId} hidden={!open} className="flex flex-col gap-4 pb-5">{children}</div>
  </div>;
}
