"use client";

import Link from "next/link";
import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { ChevronRight, CircleAlert, CircleCheck, Eye, EyeOff, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

// Shared auth task patterns. Each auth form, step and result uses these, so
// focus, pending work, feedback and secondary actions behave the same in
// every task.

/** The 3px translucent Signal Teal ring of the shared Button and Input. */
export const AUTH_FOCUS_RING = "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Marks the region that owns focus for an auth task: the frame card or a settings task. */
export const AUTH_SCOPE_ATTRIBUTE = "data-auth-scope";

/**
 * Moves focus to a new task target only while the task still owns focus:
 * focus is inside the same auth region, or it fell to the page body because
 * the focused control left. A person who moved focus to another control keeps it.
 */
export function focusIfOwned(target: HTMLElement | null): boolean {
  if (!target || !target.isConnected) return false;
  const active = document.activeElement;
  const scope = target.closest(`[${AUTH_SCOPE_ATTRIBUTE}]`);
  // A removed control can stay the active element in some engines; treat it as lost focus.
  const owned = !active || active === document.body || !active.isConnected || (scope !== null && scope.contains(active));
  if (owned) target.focus();
  return owned;
}

/**
 * One owned operation at a time. The ref check is synchronous, so a second
 * activation in the same frame cannot start a second request. `pending` names
 * the action that owns the work, so only its control shows progress.
 */
export function usePendingAction<Key extends string = string>() {
  const busy = useRef(false);
  const [pending, setPending] = useState<Key | null>(null);
  const run = useCallback(async (key: Key, work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    try {
      await work();
    } finally {
      busy.current = false;
      setPending(null);
    }
  }, []);
  const isBusy = useCallback(() => busy.current, []);
  return { pending, busy: pending !== null, run, isBusy };
}

/**
 * The control that owns pending work stays native-enabled, so it keeps focus.
 * aria-disabled, aria-busy and the click guard stop a second activation. The
 * label stays at full contrast and a spinner marks the work. Controls that
 * only wait for another action use the native `disabled` state.
 */
export function PendingButton({ pending = false, pendingLabel, reserveIconSpace = false, disabled, onClick, className, children, ...props }: ComponentProps<typeof Button> & {
  pending?: boolean;
  /** Replaces the label while pending. Without it the label stays and the spinner comes first. */
  pendingLabel?: string;
  /** Keeps a left-aligned label in place when the spinner appears. */
  reserveIconSpace?: boolean;
}) {
  return (
    <Button
      {...props}
      disabled={pending ? false : disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(pending && "cursor-progress active:scale-100", className)}
    >
      {pending || reserveIconSpace ? <LoaderCircle aria-hidden="true" data-icon="pending" className={cn(pending ? "animate-spin motion-reduce:animate-none" : "invisible")} /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}

/** Props for a field that must stay focused and readable while its form waits. */
export function pendingFieldProps(pending: boolean) {
  return { readOnly: pending || undefined, "aria-disabled": pending || undefined };
}

type MessageTone = "error" | "success" | "progress" | "note";

/**
 * Feedback with a meaning icon and text. Errors are alerts; the rest are
 * status messages. A note has no icon, because the control it describes
 * already shows progress. Set announce=false inside an existing live region.
 */
export function AuthMessage({ tone, id, className, announce = true, children }: { tone: MessageTone; id?: string; className?: string; announce?: boolean; children: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : tone === "success" ? CircleCheck : tone === "progress" ? LoaderCircle : null;
  return (
    <p
      id={id}
      role={announce ? tone === "error" ? "alert" : "status" : undefined}
      className={cn(
        "flex min-w-0 items-start gap-2 text-sm",
        tone === "error" ? "text-danger" : tone === "success" ? "text-success" : "text-on-surface-variant",
        className
      )}
    >
      {Icon ? <Icon aria-hidden="true" data-icon={tone} className={cn("mt-0.5 size-4 shrink-0", tone === "progress" && "animate-spin motion-reduce:animate-none")} /> : null}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

const AUTH_TEXT_ACTION = cn(
  "inline-flex w-fit max-w-full items-center self-start rounded-sm py-0.5 text-left text-sm font-medium text-info underline decoration-info/50 underline-offset-4 transition-colors duration-150 hover:decoration-info motion-reduce:transition-none disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50",
  AUTH_FOCUS_RING
);

/** A content-sized text link. `document` makes a full page load, which ends any work in this page. */
export function AuthLink({ href, document: fullLoad = false, className, children, ...props }: Omit<ComponentProps<"a">, "href"> & { href: string; document?: boolean }) {
  if (fullLoad) return <a href={href} className={cn(AUTH_TEXT_ACTION, className)} {...props}>{children}</a>;
  return <Link href={href} className={cn(AUTH_TEXT_ACTION, className)} {...props}>{children}</Link>;
}

/** A content-sized secondary action, such as Start again, styled as a link. */
export function AuthTextButton({ className, type = "button", ...props }: ComponentProps<"button">) {
  return <button type={type} className={cn(AUTH_TEXT_ACTION, className)} {...props} />;
}

/** Other ways to finish the same task. They change only this page. */
export function AuthAlternatives({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <p id={id} className="text-xs font-medium text-on-surface-variant">{label}</p>
      {/* Long labels wrap inside narrow columns instead of overflowing them. */}
      <div className="flex min-w-0 flex-wrap gap-2 [&>button]:h-auto [&>button]:min-h-9 [&>button]:max-w-full [&>button]:whitespace-normal">{children}</div>
    </div>
  );
}

/** A native disclosure with the product chevron instead of the browser marker. */
export function AuthDisclosure({ summary, className, children }: { summary: ReactNode; className?: string; children: ReactNode }) {
  return (
    <details className={cn("group/disclosure", className)}>
      <summary
        className={cn(
          "inline-flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 text-sm font-medium text-on-surface-variant transition-colors duration-150 hover:text-on-surface motion-reduce:transition-none [&::-webkit-details-marker]:hidden",
          AUTH_FOCUS_RING
        )}
      >
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform duration-150 group-open/disclosure:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

/**
 * A new-password field with a show/hide control. The input keeps its id,
 * name, autocomplete and selection. Spellcheck stays off, so shown text is
 * not sent to a spelling service.
 */
export function NewPasswordInput({ revealLabel, className, ref, ...props }: Omit<ComponentProps<typeof Input>, "type" | "ref"> & { revealLabel: string; ref?: RefObject<HTMLInputElement | null> }) {
  const [shown, setShown] = useState(false);
  const ownInput = useRef<HTMLInputElement>(null);
  const input = ref ?? ownInput;
  const selection = useRef<{ start: number; end: number; direction: "forward" | "backward" | "none" } | null>(null);
  useLayoutEffect(() => {
    const saved = selection.current;
    selection.current = null;
    if (saved && input.current) input.current.setSelectionRange(saved.start, saved.end, saved.direction);
  }, [shown, input]);
  const toggle = () => {
    const field = input.current;
    if (field && field.selectionStart !== null && field.selectionEnd !== null) {
      selection.current = { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? "none" };
    }
    setShown(value => !value);
  };
  return (
    <div className="relative">
      <Input
        {...props}
        ref={input}
        type={shown ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className={cn("pr-11 [&::-ms-reveal]:hidden", className)}
      />
      <button
        type="button"
        aria-label={revealLabel}
        aria-pressed={shown}
        aria-controls={props.id}
        onClick={toggle}
        className={cn(
          "absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-on-surface-variant transition-colors duration-150 hover:text-on-surface motion-reduce:transition-none",
          AUTH_FOCUS_RING
        )}
      >
        {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
}
