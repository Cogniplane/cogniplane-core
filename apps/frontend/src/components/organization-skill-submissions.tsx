"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrganizationSkillSubmission, OrganizationSkillSubmissionDetail, PersonalSkill, PersonalSkillScope } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import {
  getMySkillSubmission, listMySkillSubmissions, resubmitSkillSubmission,
  submitPersonalSkill, withdrawSkillSubmission
} from "@/lib/organization-skill-submissions-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SafeMarkdown } from "./safe-markdown";

const statusLabel: Record<OrganizationSkillSubmission["status"], string> = {
  pending: "Awaiting review", changes_requested: "Changes requested", declined: "Declined",
  withdrawn: "Withdrawn", accepted: "Accepted as draft"
};
const date = (value: string) => new Date(value).toLocaleString();
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";
const matchesScope = (received: PersonalSkillScope, expected: PersonalSkillScope) =>
  received.tenantId === expected.tenantId && received.userId === expected.userId;

export function OrganizationSkillSubmissions({ expectedScope, skills, initialSkillId, requestedSubmissionId = null, onBack }: {
  expectedScope: PersonalSkillScope;
  skills: PersonalSkill[];
  initialSkillId: string | null;
  requestedSubmissionId?: string | null;
  onBack: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<OrganizationSkillSubmission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrganizationSkillSubmissionDetail | null>(null);
  const [sourceSkillId, setSourceSkillId] = useState(initialSkillId ?? "");
  const [sourceRevision, setSourceRevision] = useState<number | null>(null);
  const [updateTarget, setUpdateTarget] = useState<string | null>(null);
  const [resubmitTarget, setResubmitTarget] = useState<{ id: string; version: number } | null>(null);
  const [note, setNote] = useState("");
  const [composing, setComposing] = useState(Boolean(initialSkillId));
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [conflictBlocked, setConflictBlocked] = useState(false);
  const [scopeError, setScopeError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  // `generation` guards the open view (detail, compose, and actions).
  // `listGeneration` guards list loads. Opening a detail must not discard the list.
  const generation = useRef(0);
  const listGeneration = useRef(0);
  const scopeRef = useRef(expectedScope);
  const mountedScope = useRef(expectedScope);
  const heading = useRef<HTMLHeadingElement>(null);
  const sourceSkill = useMemo(() => skills.find((skill) => skill.id === sourceSkillId) ?? null, [skills, sourceSkillId]);
  const availableRevisions = useMemo(() => {
    if (!sourceSkill) return [];
    const list = [{ label: `Latest saved draft · revision ${sourceSkill.latest.revision}`, revision: sourceSkill.latest }];
    if (sourceSkill.active && sourceSkill.active.revision !== sourceSkill.latest.revision)
      list.push({ label: `Active in my chats · revision ${sourceSkill.active.revision}`, revision: sourceSkill.active });
    if (sourceSkill.active && sourceSkill.active.revision === sourceSkill.latest.revision)
      list[0].label = `Active in my chats · revision ${sourceSkill.latest.revision}`;
    return list;
  }, [sourceSkill]);
  const selectedRevision = availableRevisions.find((item) => item.revision.revision === sourceRevision)?.revision
    ?? availableRevisions[0]?.revision ?? null;

  const lockScope = useCallback((expired = false) => {
    generation.current += 1; listGeneration.current += 1;
    setScopeError(true); setSessionExpired(expired); setItems([]); setDetail(null);
    setSelectedId(null); setComposing(false); setNote("");
  }, []);
  useEffect(() => {
    if (!matchesScope(mountedScope.current, expectedScope)) lockScope();
    mountedScope.current = expectedScope;
    scopeRef.current = expectedScope;
  }, [expectedScope, lockScope]);
  const check = useCallback((scope: PersonalSkillScope) => {
    if (matchesScope(scope, scopeRef.current)) return true;
    lockScope(); return false;
  }, [lockScope]);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.code === "personal_skill_scope_changed" || cause.code === "submission_scope_changed")) {
      lockScope(cause.status === 401); return;
    }
    setError(errorText(cause));
  }, [lockScope]);
  const refresh = useCallback(() => {
    const stamp = ++listGeneration.current;
    return listMySkillSubmissions().then((result) => {
      if (stamp !== listGeneration.current || !check(result.scope)) return false;
      setItems(result.submissions);
      setError(null);
      return true;
    }).catch((cause: unknown) => { if (stamp === listGeneration.current) handleError(cause); return false; })
      .finally(() => { if (stamp === listGeneration.current) setLoading(false); });
  }, [check, handleError]);
  useEffect(() => {
    void refresh();
    const activeGeneration = generation;
    const activeListGeneration = listGeneration;
    return () => { activeGeneration.current += 1; activeListGeneration.current += 1; };
  }, [refresh]);
  const open = useCallback(async (id: string) => {
    const stamp = ++generation.current;
    setSelectedId(id); setComposing(false); setDetail(null); setError(null); setDetailLoading(true);
    setNeedsRefresh(false);
    setConflictBlocked(false);
    try {
      const result = await getMySkillSubmission(id);
      if (stamp !== generation.current || !check(result.scope)) return;
      setDetail(result.submission);
      setSourceSkillId(result.submission.sourceSkillId);
      heading.current?.focus();
    } catch (cause) { if (stamp === generation.current) handleError(cause); }
    finally { if (stamp === generation.current) setDetailLoading(false); }
  }, [check, handleError]);
  useEffect(() => {
    if (!requestedSubmissionId) return;
    let active = true;
    queueMicrotask(() => { if (active) void open(requestedSubmissionId); });
    return () => { active = false; };
  }, [requestedSubmissionId, open]);
  const run = async (work: () => Promise<OrganizationSkillSubmissionDetail>) => {
    if (busy || scopeError) return;
    const stamp = generation.current;
    setBusy(true); setError(null);
    setNeedsRefresh(false);
    try {
      const submission = await work();
      if (stamp !== generation.current) return;
      setDetail(submission); setSelectedId(submission.id); setComposing(false); setNote("");
      setItems((current) => [submission, ...current.filter((item) => item.id !== submission.id)]);
      heading.current?.focus();
    } catch (cause) {
      if (stamp !== generation.current) return;
      handleError(cause);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) {
        setError(`${errorText(cause)} Review the current state before trying again. Your note is still here.`);
        setNeedsRefresh(true);
        setConflictBlocked(true);
      }
    } finally { setBusy(false); }
  };
  const begin = (skillId = "", target: string | null = null) => {
    generation.current++;
    setSourceSkillId(skillId); setSourceRevision(null); setUpdateTarget(target); setNote("");
    setResubmitTarget(null);
    setSelectedId(null); setDetail(null); setComposing(true); setError(null);
    setNeedsRefresh(false);
    setConflictBlocked(false);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const sourceExists = skills.some((skill) => skill.id === detail?.sourceSkillId);
  const canResubmit = detail?.status === "changes_requested" && sourceExists;
  const existingOpen = sourceSkill && !resubmitTarget ? items.find((item) => item.sourceSkillId === sourceSkill.id && (item.status === "pending" || item.status === "changes_requested")) : null;

  return <section className="space-y-5 pt-5" aria-labelledby="submission-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="submission-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">My submissions</h2>
        <p className="mt-1 text-sm text-on-surface-variant">Share a saved revision for organization review. Your private skill stays yours.</p></div>
      <Button size="sm" variant="outline" onClick={() => { if (requestedSubmissionId) router.replace("/settings/capabilities"); onBack(); }}>Back to private skills</Button>
    </div>
    {scopeError ? <div role="alert" className="rounded-lg bg-danger-surface p-4 text-sm text-danger">{sessionExpired ? "Your session expired. Sign in again and reload this page." : "Your account or organization changed. Reload this page before viewing submissions."}<Button size="sm" variant="outline" className="ml-3" onClick={() => window.location.reload()}>Reload page</Button></div> : null}
    {error && !scopeError ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-danger-surface p-3 text-sm text-danger"><span>{error}</span>{needsRefresh ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void (async () => {
      const targetId = resubmitTarget?.id ?? selectedId;
      if (!targetId) {
        if (await refresh()) { setNeedsRefresh(false); setConflictBlocked(false); }
        return;
      }
      const stamp = generation.current;
      try {
        const result = await getMySkillSubmission(targetId);
        if (stamp !== generation.current || !check(result.scope)) return;
        setDetail(result.submission);
        setItems((current) => [result.submission, ...current.filter((item) => item.id !== targetId)]);
        if (resubmitTarget && result.submission.status === "changes_requested") { setResubmitTarget({ id: targetId, version: result.submission.version }); setConflictBlocked(false); setError(null); }
        else if (resubmitTarget) setError("This submission is no longer waiting for changes. Your note is still here.");
        else { setConflictBlocked(false); setError(null); }
        setNeedsRefresh(false);
      } catch (cause) { if (stamp === generation.current) handleError(cause); }
    })()}>Refresh submission state</Button> : null}</div> : null}
    {!scopeError && composing ? <div className="grid gap-6 rounded-xl border border-outline-variant bg-surface p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        <div><h3 className="font-semibold">{resubmitTarget ? "Submit a new revision" : updateTarget ? "Submit an update" : "Submit for review"}</h3>
          <p className="mt-1 text-sm text-on-surface-variant">The revision in the preview is the exact text reviewers will receive.</p></div>
        <div><label htmlFor="submission-skill" className="text-sm font-medium">Private skill</label><select id="submission-skill" className="mt-1 h-10 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm" value={sourceSkillId} disabled={busy || Boolean(resubmitTarget || updateTarget)} onChange={(event) => { setSourceSkillId(event.target.value); setSourceRevision(null); }}><option value="">Choose a saved skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.latest.content.name}</option>)}</select></div>
        {sourceSkill ? <div><label htmlFor="submission-revision" className="text-sm font-medium">Saved revision to share</label><select id="submission-revision" className="mt-1 h-10 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm" value={selectedRevision?.revision ?? ""} disabled={busy} onChange={(event) => setSourceRevision(Number(event.target.value))}>{availableRevisions.map((item) => <option key={item.revision.revision} value={item.revision.revision}>{item.label}</option>)}</select></div> : null}
        {updateTarget ? <p className="rounded-md bg-info-surface p-3 text-sm text-on-surface">This update targets the organization skill <strong>{updateTarget}</strong>. The current released revision stays available until an admin releases the accepted draft.</p> : null}
        {existingOpen ? <p className="rounded-md bg-warning-surface p-3 text-sm text-warning">This private skill already has an open submission. Open that review to withdraw it or submit the requested changes.</p> : null}
        <div><label htmlFor="submission-note" className="text-sm font-medium">Note to reviewers</label><textarea id="submission-note" className="mt-1 min-h-28 w-full rounded-md border border-outline-variant bg-surface p-3 text-sm" maxLength={4000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Explain what this skill helps with or what changed." /></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || conflictBlocked || !sourceSkill || !selectedRevision || Boolean(existingOpen)} onClick={() => void run(async () => {
          if (!sourceSkill || !selectedRevision) throw new Error("Choose a saved revision.");
          const result = resubmitTarget
            ? await resubmitSkillSubmission(resubmitTarget.id, { scope: expectedScope, version: resubmitTarget.version, sourceRevision: selectedRevision.revision, note })
            : await submitPersonalSkill({ scope: expectedScope, personalSkillId: sourceSkill.id, sourceRevision: selectedRevision.revision, note, targetOrganizationSkillId: updateTarget });
          if (!check(result.scope)) throw new Error("Your account or organization changed.");
          return result.submission;
        })}>{busy ? "Submitting…" : resubmitTarget ? "Submit revised copy" : updateTarget ? "Submit update" : "Submit for review"}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { setComposing(false); setNote(""); setResubmitTarget(null); }}>Cancel</Button></div>
      </div>
      <div className="min-w-0 rounded-lg bg-surface-container-low p-4"><h3 className="mb-2 font-semibold">Shared-content preview</h3>{selectedRevision ? <><p className="text-xs text-on-surface-variant">Revision {selectedRevision.revision} · {sourceSkill?.active?.revision === selectedRevision.revision ? "Active" : "Saved draft"}</p><h4 className="mt-4 text-lg font-semibold">{selectedRevision.content.name}</h4><p className="mt-1 text-sm text-on-surface-variant">{selectedRevision.content.description}</p><div className="mt-5 max-h-[34rem] overflow-auto text-sm"><SafeMarkdown>{selectedRevision.content.instructions}</SafeMarkdown></div>{selectedRevision.validationMessages.length ? <p className="mt-4 text-xs text-warning">{selectedRevision.validationMessages.join(" · ")}</p> : null}</> : <p className="text-sm text-on-surface-variant">Choose a private skill to preview the saved text.</p>}</div>
    </div> : null}
    {!scopeError && !composing && selectedId ? <div className="space-y-5 rounded-xl border border-outline-variant bg-surface p-5">
      <Button size="sm" variant="ghost" onClick={() => { generation.current++; setSelectedId(null); setDetail(null); setError(null); if (requestedSubmissionId) router.replace("/settings/capabilities?view=submissions"); void refresh(); }}>Back to submissions</Button>
      {detailLoading ? <Skeleton className="h-48" /> : detail ? <><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-on-surface-variant">Submission {detail.latest.attempt} · {date(detail.latest.submittedAt)}</p><h3 className="mt-1 text-xl font-semibold">{detail.latest.snapshot.content.name}</h3><p className="text-sm text-on-surface-variant">{detail.latest.snapshot.content.description}</p></div><span className="rounded-md bg-surface-container px-2 py-1 text-xs font-semibold">{statusLabel[detail.status]}</span></div>
        {detail.latest.feedback ? <div className="rounded-md bg-warning-surface p-4 text-sm"><strong>Reviewer feedback</strong><p className="mt-1 whitespace-pre-wrap">{detail.latest.feedback}</p></div> : null}
        {detail.status === "accepted" ? <p className="rounded-md bg-info-surface p-4 text-sm">{detail.updates?.some((update) => update.kind === "released") ? "Accepted. See the dated release history below for what admins released." : "Accepted as an organization draft. Admins manage releases separately."} Your private skill remains private.</p> : null}
        <div className="flex flex-wrap gap-2">{detail.status === "pending" || detail.status === "changes_requested" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { const result = await withdrawSkillSubmission(detail.id, { scope: expectedScope, version: detail.version }); if (!check(result.scope)) throw new Error("Your account or organization changed."); return result.submission; })}>{busy ? "Withdrawing…" : "Withdraw submission"}</Button> : null}
          {canResubmit ? <Button size="sm" disabled={busy} onClick={() => { setSourceSkillId(detail.sourceSkillId); setSourceRevision(null); setUpdateTarget(detail.targetOrganizationSkillId); setResubmitTarget({ id: detail.id, version: detail.version }); setNote(detail.latest.note); setComposing(true); }}>Revise and resubmit</Button> : null}
          {detail.status === "accepted" && sourceExists && detail.acceptedOrganizationSkillId ? <Button size="sm" disabled={busy} onClick={() => begin(detail.sourceSkillId, detail.acceptedOrganizationSkillId)}>Submit update</Button> : null}</div>
        {detail.status === "changes_requested" && !sourceExists ? <p className="text-sm text-on-surface-variant">The original private skill no longer exists. Its submitted history remains here.</p> : null}
        <div className="border-t border-outline-variant pt-4"><h4 className="mb-3 font-semibold">Submitted instructions</h4><div className="max-w-prose text-sm"><SafeMarkdown>{detail.latest.snapshot.content.instructions}</SafeMarkdown></div></div>
        <div className="border-t border-outline-variant pt-4"><h4 className="mb-2 font-semibold">History</h4><ol className="space-y-3">{detail.attempts.map((attempt) => <li key={attempt.attempt} className="rounded-md bg-surface-container-low p-3 text-sm"><strong>Submission {attempt.attempt} · {statusLabel[attempt.status]}</strong><p className="mt-1 text-on-surface-variant">Revision {attempt.snapshot.sourceRevision} · {date(attempt.submittedAt)}</p>{attempt.note ? <p className="mt-2 whitespace-pre-wrap">{attempt.note}</p> : null}{attempt.feedback ? <p className="mt-2 whitespace-pre-wrap text-on-surface-variant">Reviewer: {attempt.feedback}</p> : null}</li>)}</ol>{detail.updates?.filter((update) => update.kind === "released").map((update) => <p key={update.id} className="mt-3 rounded-md bg-info-surface p-3 text-sm">Released revision {update.organizationRevisionId ?? ""} {update.audience === "test-users" ? "to test users" : update.audience === "members" ? "to members" : ""} on {date(update.createdAt)}. Later releases may have changed what is available now.</p>)}</div>
      </> : <p role="status" className="text-sm text-on-surface-variant">This submission is not available. It may have been removed or you may no longer have access.</p>}
    </div> : null}
    {!scopeError && !composing && !selectedId ? <div className="space-y-4"><div className="flex items-center justify-between"><h3 className="font-semibold">Review history</h3><Button size="sm" disabled={busy || skills.length === 0} onClick={() => begin()}>New submission</Button></div>{loading ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : items.length ? <ul className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface">{items.map((item) => <li key={item.id}><button className="w-full p-4 text-left hover:bg-surface-container-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void open(item.id)}><span className="flex flex-wrap items-center justify-between gap-2"><strong>{item.latest.snapshot.content.name}</strong><span className="rounded-md bg-surface-container px-2 py-1 text-xs">{statusLabel[item.status]}</span></span><span className="mt-1 block text-sm text-on-surface-variant">Revision {item.latest.snapshot.sourceRevision} · {date(item.latest.submittedAt)}</span></button></li>)}</ul> : <p className="rounded-lg border border-dashed border-outline-variant p-6 text-sm text-on-surface-variant">No submissions yet. Choose a saved private skill and send one revision for review.</p>}</div> : null}
  </section>;
}
