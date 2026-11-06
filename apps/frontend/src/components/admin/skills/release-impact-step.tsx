"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import type { AdminSkillReleaseImpact } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Impact = AdminSkillReleaseImpact;
type Snapshot = Impact["snapshot"];

const audienceLabel = (audience: Impact["current"]["audience"]) =>
  audience === "members" ? "All members" : audience === "test-users" ? "Test users" : "Off";
const revisionLabel = (state: Impact["current"]) =>
  state.revisionNumber === null ? "No active revision" : `Revision ${state.revisionNumber}`;

export function ReleaseImpactStep({ choiceKey, load, confirm, confirmLabel, previewLabel = "Preview impact", disabled = false, onAccessError }: {
  choiceKey: string;
  load: () => Promise<Impact>;
  confirm: (snapshot: Snapshot) => Promise<void>;
  confirmLabel: string;
  previewLabel?: string;
  disabled?: boolean;
  onAccessError?: (cause: unknown) => void;
}) {
  const { user } = useAuth();
  const scopeKey = `${user?.tenantId ?? ""}:${user?.userId ?? ""}`;
  const [result, setResult] = useState<{ choiceKey: string; scopeKey: string; impact: Impact } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(0);
  const submittingRef = useRef(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const impactHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const focusAfterPreview = useRef(false);
  const focusAfterError = useRef(false);
  const focusAfterConfirm = useRef(false);
  const currentScope = useRef(scopeKey);
  const currentChoice = useRef(choiceKey);
  useLayoutEffect(() => {
    const changed = currentScope.current !== scopeKey || currentChoice.current !== choiceKey;
    currentScope.current = scopeKey; currentChoice.current = choiceKey;
    if (changed) {
      focusAfterPreview.current = false; focusAfterError.current = false; focusAfterConfirm.current = false;
      // A different choice or actor must start a new review, even after switching back.
      setResult(null); setError(null); setLoading(false);
    }
    // This counter tracks async work. Cleanup must advance its current value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { requestId.current++; };
  }, [scopeKey, choiceKey]);
  const shown = result?.choiceKey === choiceKey && result.scopeKey === scopeKey ? result.impact : null;
  useEffect(() => {
    if (shown && focusAfterPreview.current) {
      focusAfterPreview.current = false;
      if (document.activeElement === document.body) impactHeading.current?.focus();
    }
  }, [shown]);
  useEffect(() => {
    if (error && focusAfterError.current) {
      focusAfterError.current = false;
      if (document.activeElement === document.body || document.activeElement === previewButton.current) errorMessage.current?.focus();
    }
  }, [error]);
  useEffect(() => {
    if (!shown && !submitting && !error && focusAfterConfirm.current) {
      focusAfterConfirm.current = false;
      if (document.activeElement === document.body) previewButton.current?.focus();
    }
  }, [shown, submitting, error]);

  const preview = async () => {
    if (loading || submittingRef.current || disabled) return;
    focusAfterPreview.current = document.activeElement === previewButton.current || document.activeElement === refreshButton.current;
    const id = ++requestId.current;
    const requestedChoice = choiceKey;
    const requestedScope = scopeKey;
    setResult(null); setError(null); setLoading(true);
    try {
      const impact = await load();
      if (id !== requestId.current || currentChoice.current !== requestedChoice || currentScope.current !== requestedScope) return;
      setResult({ choiceKey: requestedChoice, scopeKey: requestedScope, impact });
    } catch (cause) {
      if (id !== requestId.current || currentChoice.current !== requestedChoice || currentScope.current !== requestedScope) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessError?.(cause);
      focusAfterError.current = focusAfterPreview.current;
      focusAfterPreview.current = false;
      setError(cause instanceof Error ? cause.message : "Could not load release impact.");
    } finally { if (id === requestId.current) setLoading(false); }
  };
  const act = async () => {
    if (!shown || submittingRef.current || disabled || loading) return;
    const id = requestId.current;
    const ownedFocus = document.activeElement === confirmButton.current;
    submittingRef.current = true;
    setSubmitting(true); setError(null);
    try {
      await confirm(shown.snapshot);
      if (id !== requestId.current || currentChoice.current !== choiceKey || currentScope.current !== scopeKey) return;
      focusAfterConfirm.current = ownedFocus;
      setResult(null);
    } catch (cause) {
      if (id !== requestId.current || currentChoice.current !== choiceKey || currentScope.current !== scopeKey) return;
      setResult(null);
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessError?.(cause);
      focusAfterError.current = ownedFocus;
      setError(cause instanceof ApiError && cause.status === 409
        ? "The skill changed since this preview. Refresh the impact before you try again."
        : !(cause instanceof ApiError) || cause.status >= 500
          ? `${cause instanceof Error ? `${cause.message} ` : ""}The release may have completed. Refresh the impact to check the current state before you try again.`
          : `${cause.message} Refresh the impact before you try again.`);
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  return <div className="space-y-3">
    {!shown ? <Button ref={previewButton} type="button" size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal break-words py-1.5" disabled={loading || submitting || disabled} onClick={() => void preview()}>{submitting ? "Saving…" : loading ? "Checking impact…" : error ? "Refresh impact" : previewLabel}</Button> : null}
    {loading ? <div role="status" aria-label="Loading release impact" className="space-y-2"><span className="sr-only">Checking release impact.</span><Skeleton className="h-8" /><Skeleton className="h-12" /></div> : null}
    {error ? <p ref={errorMessage} tabIndex={-1} role="alert" className="rounded-md bg-danger-surface p-3 text-sm text-danger">{error}</p> : null}
    {shown ? <div className="space-y-3 rounded-lg border border-outline-variant bg-surface p-4 text-sm">
      <h5 ref={impactHeading} tabIndex={-1} className="font-semibold">Release impact</h5>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="text-xs font-medium text-on-surface-variant">Current</dt><dd className="mt-1">{revisionLabel(shown.current)} · {audienceLabel(shown.current.audience)}</dd></div>
        <div><dt className="text-xs font-medium text-on-surface-variant">After confirmation</dt><dd className="mt-1">{revisionLabel(shown.proposed)} · {audienceLabel(shown.proposed.audience)}</dd></div>
      </dl>
      <p>{shown.members.gaining} members become eligible; {shown.members.losing} are no longer eligible. {shown.members.testUsers} of {shown.members.total} members are test users.</p>
      <div><p className="font-medium">Saved settings at preview time</p><p className="mt-1 text-xs text-on-surface-variant">Counts describe saved settings, not affected chats. Project or personal defaults and member access can still exclude this skill. Changes take effect on the next turn.</p>
        <ul className="mt-2 grid gap-1 text-xs text-on-surface-variant sm:grid-cols-3">
          <li>Projects: {shown.configuredReferences.projects.inherited} inherit defaults, {shown.configuredReferences.projects.explicitSelected} select it</li>
          <li>Personal defaults: {shown.configuredReferences.personalDefaults.inherited} inherit defaults, {shown.configuredReferences.personalDefaults.explicitSelected} select it</li>
          <li>Chats: {shown.configuredReferences.sessions.inherited} inherit defaults, {shown.configuredReferences.sessions.explicitSelected} select it</li>
        </ul>
      </div>
      <div className="flex flex-wrap gap-2"><Button ref={confirmButton} type="button" size="sm" className="h-auto min-h-8 max-w-full whitespace-normal break-words py-1.5" disabled={submitting || disabled} onClick={() => void act()}>{submitting ? "Saving…" : confirmLabel}</Button><Button ref={refreshButton} type="button" size="sm" variant="ghost" disabled={submitting || disabled} onClick={() => void preview()}>Refresh impact</Button></div>
    </div> : null}
  </div>;
}
