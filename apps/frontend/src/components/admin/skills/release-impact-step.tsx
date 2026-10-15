"use client";

import { useEffect, useRef, useState } from "react";
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
  const currentScope = useRef(scopeKey);
  const currentChoice = useRef(choiceKey);
  useEffect(() => { currentScope.current = scopeKey; currentChoice.current = choiceKey; }, [scopeKey, choiceKey]);
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
    focusAfterError.current = document.activeElement === confirmButton.current;
    submittingRef.current = true;
    setSubmitting(true); setError(null);
    try {
      await confirm(shown.snapshot);
      if (currentChoice.current === choiceKey && currentScope.current === scopeKey) setResult(null);
    } catch (cause) {
      setResult(null);
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessError?.(cause);
      setError(cause instanceof ApiError && cause.status === 409
        ? "The skill changed since this preview. Refresh the impact before you try again."
        : cause instanceof Error ? `${cause.message} Refresh the impact before you try again.` : "The release failed. Refresh the impact before you try again.");
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  return <div className="space-y-3">
    {!shown ? <Button ref={previewButton} type="button" size="sm" variant="outline" disabled={loading || disabled} onClick={() => void preview()}>{loading ? "Checking impact…" : error ? "Refresh impact" : previewLabel}</Button> : null}
    {loading ? <div aria-label="Loading release impact" className="space-y-2"><Skeleton className="h-8" /><Skeleton className="h-12" /></div> : null}
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
      <div className="flex flex-wrap gap-2"><Button ref={confirmButton} type="button" size="sm" disabled={submitting || disabled} onClick={() => void act()}>{submitting ? "Saving…" : confirmLabel}</Button><Button ref={refreshButton} type="button" size="sm" variant="ghost" disabled={submitting} onClick={() => void preview()}>Refresh impact</Button></div>
    </div> : null}
  </div>;
}
