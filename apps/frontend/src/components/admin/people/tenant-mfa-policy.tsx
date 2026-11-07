"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MfaPolicy } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { fetchTenantMfaPolicy, localAuthMessage, saveTenantMfaPolicy } from "../../../lib/local-auth-api";
import { queryKeys } from "../../../lib/query-keys";
import { StepUpDialog } from "./step-up-dialog";

// From the weakest to the strictest, the same order as the backend check.
export const MFA_POLICY_OPTIONS: { value: MfaPolicy; label: string; summary: string }[] = [
  { value: "optional", label: "Optional", summary: "Each person decides to add an authenticator app." },
  { value: "required_for_admins", label: "Required for owners and admins", summary: "Owners and admins must add an authenticator app at their next sign-in." },
  { value: "required_for_all", label: "Required for everyone", summary: "Every person must add an authenticator app at their next sign-in." }
];

export function isWeakerPolicy(next: MfaPolicy, current: MfaPolicy): boolean {
  const rank = (policy: MfaPolicy) => MFA_POLICY_OPTIONS.findIndex((option) => option.value === policy);
  return rank(next) < rank(current);
}

// Two-step verification rule for a local tenant. A stricter rule applies at
// once; only an owner can make it weaker, after a step-up
// (docs/architecture/local-accounts.md).
export function TenantMfaPolicy({ actorRole }: { actorRole: "owner" | "admin" }) {
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: queryKeys.admin.mfaPolicy(), queryFn: fetchTenantMfaPolicy });
  const [draft, setDraft] = useState<MfaPolicy | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const saving = useRef(false);
  const retrying = useRef(false);
  const draftRevision = useRef(0);
  const current = policy.data;
  const selected = draft ?? current;
  const weaker = selected !== undefined && current !== undefined && isWeakerPolicy(selected, current);
  const blocked = weaker && actorRole !== "owner";

  const save = async (stepUpToken?: string) => {
    if (saving.current || !selected || !current || selected === current || blocked) return;
    saving.current = true;
    const revision = draftRevision.current;
    setPending(true);
    setStatus("");
    setError(null);
    try {
      const saved = await saveTenantMfaPolicy(selected, stepUpToken);
      queryClient.setQueryData(queryKeys.admin.mfaPolicy(), saved);
      if (draftRevision.current === revision) {
        setDraft(null);
        setStatus("The two-step verification rule is saved.");
      } else {
        setStatus("The submitted rule is saved. Your newer choice has not been saved.");
      }
    } catch (caught) {
      setError(localAuthMessage(caught, "The rule could not be saved. Try again."));
      // Show the rule as it is now (another manager may have changed it).
      void policy.refetch();
      if (stepUpToken) throw caught;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  const retry = async () => {
    if (retrying.current) return;
    retrying.current = true;
    setRetryPending(true);
    try { await policy.refetch(); } finally { retrying.current = false; setRetryPending(false); }
  };

  return (
    <section aria-labelledby="mfa-policy-heading" className="flex flex-col gap-3 border-t border-outline-variant pt-5">
      <div>
        <h3 id="mfa-policy-heading" className="text-base font-semibold text-on-surface">Two-step verification</h3>
        <p className="mt-1 text-sm text-on-surface-variant">Who must sign in with a code from an authenticator app.</p>
      </div>
      {!current && !policy.isError ? <p role="status" className="text-sm text-on-surface-variant">Loading the saved rule…</p> : null}
      {policy.isError || retryPending ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">{current ? "Could not refresh the rule. The last known saved rule is shown. Your choice is kept." : "Could not load the two-step verification rule. Retry to see the saved rule."}</p>
          <Button variant="outline" size="sm" aria-disabled={policy.isFetching || retryPending} aria-busy={policy.isFetching || retryPending} onClick={() => void retry()}>Retry rule</Button>
        </div>
      ) : null}
      {current ? <>
        <p className="text-sm text-on-surface-variant">{policy.isError ? "Last known saved rule" : "Saved rule"}: {MFA_POLICY_OPTIONS.find(option => option.value === current)?.label}.</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Two-step verification rule</legend>
          {MFA_POLICY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="mfa-policy"
                className="mt-1"
                checked={selected === option.value}
                onChange={() => { draftRevision.current++; setStatus(""); setError(null); setDraft(option.value); }}
              />
              <span>
                <span className="block font-medium text-on-surface">{option.label}</span>
                <span className="block text-on-surface-variant">{option.summary}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {blocked ? <p className="text-xs text-on-surface-faint">Only an owner can make this rule weaker.</p> : null}
        <Button
          className="self-start"
          disabled={!pending && (selected === current || blocked)}
          aria-disabled={pending || selected === current || blocked}
          aria-busy={pending}
          onClick={() => { if (saving.current || selected === current || blocked) return; if (weaker) setStepUpOpen(true); else void save(); }}
        >
          {pending ? "Saving…" : "Save rule"}
        </Button>
        <div className="min-h-10 text-sm">
          <p role="status" aria-live="polite" className="text-success">{status}</p>
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
        </div>
        <StepUpDialog
          open={stepUpOpen}
          onOpenChange={setStepUpOpen}
          action="tenant.mfa_policy"
          title="Make the rule weaker?"
          description="People who no longer need two-step verification can turn it off. Confirm that you want this."
          confirmLabel="Save rule"
          run={(token) => save(token)}
        />
      </> : null}
    </section>
  );
}
