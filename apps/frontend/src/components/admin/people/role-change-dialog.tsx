"use client";

import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { PILL_GRAY } from "../../../lib/ui-tokens";
import { ROLE_INFO, roleChangeEffects, type MemberRole } from "./person-access.logic";

const ROLE_ORDER: MemberRole[] = ["member", "admin", "owner"];

/**
 * Two steps in one dialog: pick a role from the permitted choices, then read
 * what the change does and confirm it. Nothing is saved before the second step.
 */
export function RoleChangeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  name: string;
  currentRole: MemberRole;
  choices: MemberRole[];
  pending: boolean;
  error: string | null;
  onConfirm: (role: MemberRole) => void;
}) {
  const [selected, setSelected] = useState<MemberRole | null>(null);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const groupName = useId();

  const handleOpenChange = (open: boolean) => {
    if (!props.pending) props.onOpenChange(open);
  };

  const target = step === "confirm" ? selected : null;
  const confirmLabel = target === "owner" ? "Make owner" : target ? `Change to ${ROLE_INFO[target].label.toLowerCase()}` : "";

  return (
    <AlertDialog open={props.open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (props.pending) event.preventDefault(); }}
      >
        {target ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="wrap-anywhere">
                {target === "owner" ? `Make ${props.name} an owner?` : `Change ${props.name} to ${ROLE_INFO[target].label.toLowerCase()}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {ROLE_INFO[props.currentRole].label} to {ROLE_INFO[target].label.toLowerCase()}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
              {roleChangeEffects(props.currentRole, target, props.name).map((effect) => (
                <li key={effect} className={effect.startsWith("You cannot undo") ? "font-medium text-warning" : undefined}>{effect}</li>
              ))}
            </ul>
            {props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}
            <AlertDialogFooter>
              <Button variant="outline" disabled={props.pending} onClick={() => setStep("choose")}>Back</Button>
              <Button onClick={() => props.onConfirm(target)} disabled={props.pending} aria-busy={props.pending}>
                {props.pending ? "Changing role…" : confirmLabel}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="wrap-anywhere">Change {props.name}&apos;s role</AlertDialogTitle>
              <AlertDialogDescription>Pick a role. You confirm the change in the next step.</AlertDialogDescription>
            </AlertDialogHeader>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Role</legend>
              {ROLE_ORDER.map((role) => {
                const isCurrent = role === props.currentRole;
                const allowed = props.choices.includes(role);
                if (!isCurrent && !allowed) return null;
                return (
                  <label
                    key={role}
                    className={cn(
                      "flex gap-3 rounded-lg border px-3 py-3 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                      isCurrent
                        ? "cursor-default border-outline-variant bg-surface-container-low"
                        : "cursor-pointer border-outline-variant hover:border-outline has-[:checked]:border-brand has-[:checked]:bg-brand-surface"
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={role}
                      disabled={isCurrent}
                      checked={selected === role}
                      onChange={() => setSelected(role)}
                      className="mt-1 size-4 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-on-surface">
                        {ROLE_INFO[role].label}
                        {isCurrent ? <span className={PILL_GRAY}>Current</span> : null}
                      </span>
                      <span className="mt-0.5 block text-sm text-on-surface-variant">{ROLE_INFO[role].summary}</span>
                      {role === "owner" && !isCurrent ? (
                        <span className="mt-1 block text-xs font-medium text-warning">Permanent. An owner cannot be demoted or removed later.</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button disabled={!selected} onClick={() => setStep("confirm")}>Continue</Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
