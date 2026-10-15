"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OrganizationSkillSubmission, OrganizationSkillSubmissionDetail, PersonalSkillContent, PersonalSkillScope } from "@cogniplane/shared-types";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import { decideSkillSubmission, getAdminSkillSubmission, listAdminSkillSubmissions, releaseSkillSubmission } from "@/lib/organization-skill-submissions-api";
import { previewAdminSkillRelease } from "@/lib/admin-api";
import { diffLines } from "./organization-skill-review.logic";
import { ReleaseImpactStep } from "./release-impact-step";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SafeMarkdown } from "@/components/safe-markdown";

type Filter = "pending" | "waiting" | "all" | "completed";
type Tab = "submission" | "changes" | "current" | "validation" | "history";
type FeedbackAction = "request_changes" | "decline";
const labels: Record<OrganizationSkillSubmission["status"], string> = {
  pending: "Needs review", changes_requested: "Waiting for author", declined: "Declined",
  withdrawn: "Withdrawn", accepted: "Accepted draft"
};
const date = (value: string) => new Date(value).toLocaleString();
const elapsed = (value: string) => {
  const days = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 86400000);
  return days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";
const sameScope = (received: PersonalSkillScope, expected: PersonalSkillScope) => received.tenantId === expected.tenantId && received.userId === expected.userId;
const suggestId = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

function SkillDocument({ content }: { content: PersonalSkillContent }) {
  return <article className="max-w-[70ch] text-sm leading-7 text-on-surface"><h3 className="text-lg font-semibold">{content.name}</h3><p className="mt-2 text-on-surface-variant">{content.description}</p><div className="mt-6"><SafeMarkdown>{content.instructions}</SafeMarkdown></div></article>;
}

export function OrganizationSkillReview({ requestedSubmissionId = null, onQueueChanged, onOpenLibrary }: { requestedSubmissionId?: string | null; onQueueChanged?: () => void; onOpenLibrary?: () => void }) {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const userId = user?.userId;
  const scope = useMemo(() => tenantId && userId ? { tenantId, userId } : null, [tenantId, userId]);
  const [items, setItems] = useState<OrganizationSkillSubmission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(requestedSubmissionId);
  const [exactSelection, setExactSelection] = useState(Boolean(requestedSubmissionId));
  const [detail, setDetail] = useState<OrganizationSkillSubmissionDetail | null>(null);
  const [loadedDetailKey, setLoadedDetailKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(requestedSubmissionId ? "all" : "pending");
  const [search, setSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<{ id: string; tab: Tab } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(Boolean(requestedSubmissionId));
  const [feedbackAction, setFeedbackAction] = useState<FeedbackAction | null>(null);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({});
  const [organizationSkillId, setOrganizationSkillId] = useState("");
  const [organizationSkillName, setOrganizationSkillName] = useState("");
  const [audience, setAudience] = useState<"test-users" | "members">("test-users");
  const [loading, setLoading] = useState(true);
  const [detailRetry, setDetailRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState(false);
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const scopeRef = useRef(scope);
  const selectedIdRef = useRef(selectedId);
  const mountedScope = useRef(scope);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const queueButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [acceptedNow, setAcceptedNow] = useState(false);
  const visible = useMemo(() => items.filter((item) => {
    if (filter === "pending" && item.status !== "pending") return false;
    if (filter === "waiting" && item.status !== "changes_requested") return false;
    if (filter === "completed" && (item.status === "pending" || item.status === "changes_requested")) return false;
    const needle = search.trim().toLowerCase();
    return !needle || [item.latest.snapshot.content.name, item.latest.snapshot.content.description, item.authorName, item.authorEmail ?? "", item.latest.note]
      .some((value) => value.toLowerCase().includes(needle));
  }), [items, filter, search]);
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const selected = visible.find((item) => item.id === selectedId) ?? (exactSelection ? null : visible[0] ?? null);
  const selectedForFetchId = selected?.id;
  const selectedForFetchVersion = selected?.version;
  const selectedDetailKey = selected ? `${selected.id}:${selected.version}` : null;
  const currentDetail = detail && detail.id === selected?.id && loadedDetailKey === selectedDetailKey ? detail : null;
  const showDetailLoading = Boolean(selected && !currentDetail && !error);
  const tab = selectedTab && selectedTab.id === selected?.id ? selectedTab.tab
    : selected?.targetOrganizationSkillId ? "changes" : "submission";

  const lockScope = useCallback((sessionExpired = false) => {
    generation.current++; detailGeneration.current++;
    setScopeError(true); setExpired(sessionExpired); setItems([]); setDetail(null); setLoadedDetailKey(null); setSelectedId(null);
    setFeedbackDrafts({}); setFeedbackAction(null); setOrganizationSkillId(""); setOrganizationSkillName("");
  }, []);
  useEffect(() => {
    if (mountedScope.current && (!scope || !sameScope(mountedScope.current, scope))) lockScope();
    mountedScope.current = scope;
    scopeRef.current = scope;
  }, [scope, lockScope]);
  useEffect(() => { selectedIdRef.current = selected?.id ?? null; }, [selected?.id]);
  const check = useCallback((received: PersonalSkillScope) => {
    if (scopeRef.current && sameScope(received, scopeRef.current)) return true;
    lockScope(); return false;
  }, [lockScope]);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.code === "submission_scope_changed" || cause.code === "personal_skill_scope_changed")) {
      lockScope(cause.status === 401); return;
    }
    setError(message(cause));
  }, [lockScope]);
  const refresh = useCallback(() => {
    if (!scope) return Promise.resolve();
    const stamp = ++generation.current;
    return listAdminSkillSubmissions().then((result) => {
      if (stamp !== generation.current || !check(result.scope)) return;
      setItems(result.submissions);
      setError(null);
    }).catch((cause: unknown) => { if (stamp === generation.current) handleError(cause); })
      .finally(() => { if (stamp === generation.current) setLoading(false); });
  }, [scope, check, handleError]);
  useEffect(() => {
    void refresh();
    const queueGeneration = generation;
    const selectedGeneration = detailGeneration;
    return () => { queueGeneration.current++; selectedGeneration.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!selectedForFetchId || scopeError) return;
    const stamp = ++detailGeneration.current;
    getAdminSkillSubmission(selectedForFetchId).then((result) => {
      if (stamp !== detailGeneration.current || !check(result.scope)) return;
      setDetail(result.submission);
      setLoadedDetailKey(`${selectedForFetchId}:${selectedForFetchVersion}`);
      setError(null);
      const target = result.submission.targetOrganizationSkillId;
      setOrganizationSkillId(target ?? suggestId(result.submission.latest.snapshot.content.name));
      setOrganizationSkillName(result.submission.latest.snapshot.content.name);
    }).catch((cause: unknown) => { if (stamp === detailGeneration.current) handleError(cause); });
    const activeGeneration = detailGeneration;
    return () => { activeGeneration.current++; };
  }, [selectedForFetchId, selectedForFetchVersion, detailRetry, check, handleError, scopeError]);
  const open = (id: string) => {
    if (id === selectedId && mobileDetail && currentDetail) return;
    selectedIdRef.current = id;
    setExactSelection(false);
    setSelectedId(id); setSelectedTab(null); setDetailRetry((current) => current + 1); setError(null); setFeedbackAction(null); setMobileDetail(true); setAcceptedNow(false);
    requestAnimationFrame(() => detailHeading.current?.focus());
  };
  const back = () => { setMobileDetail(false); requestAnimationFrame(() => (selected ? queueButtons.current[selected.id] : queueHeading.current)?.focus()); };
  const draftKey = detail && feedbackAction ? `${detail.id}:${feedbackAction}` : "";
  const feedback = feedbackDrafts[draftKey] ?? "";
  const decide = async (action: FeedbackAction | "accept") => {
    if (!scope || !currentDetail || busy || scopeError) return;
    if (action !== "accept" && !feedback.trim()) { setError("Write a message for the author before sending this decision."); return; }
    if (action === "accept" && (!organizationSkillId.trim() || !organizationSkillName.trim())) { setError("Enter the organization skill ID and name."); return; }
    const id = currentDetail.id;
    setBusy(true); setError(null);
    try {
      const result = await decideSkillSubmission(id, {
        scope, version: currentDetail.version, action, reason: action === "accept" ? null : feedback.trim(),
        organizationSkillId: action === "accept" ? organizationSkillId.trim() : null,
        organizationSkillName: action === "accept" ? organizationSkillName.trim() : null,
        expectedOrganizationVersion: action === "accept" ? currentDetail.organizationSkill?.version ?? null : null
      });
      if (!check(result.scope)) return;
      onQueueChanged?.();
      if (selectedIdRef.current !== id) {
        setItems((current) => current.map((item) => item.id === id ? result.submission : item));
        return;
      }
      setSelectedId(id);
      setFilter("all");
      setDetail(result.submission);
      setLoadedDetailKey(`${result.submission.id}:${result.submission.version}`);
      setItems((current) => current.map((item) => item.id === id ? result.submission : item));
      setFeedbackAction(null);
      if (action === "accept") { setAcceptedNow(true); }
      else setFeedbackDrafts((current) => { const next = { ...current }; delete next[`${id}:${action}`]; return next; });
      detailHeading.current?.focus();
    } catch (cause) {
      if (selectedIdRef.current !== id) return;
      handleError(cause);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) {
        setError(`${message(cause)} The review may have changed. Reload the current submission before deciding again. Your note is still here.`);
      }
    } finally { setBusy(false); }
  };
  const snapshot = detail?.latest.snapshot;
  const current = detail?.organizationSkill?.activeContent ?? null;
  const currentDraft = detail?.organizationSkill?.currentDraftContent ?? null;
  const isUpdate = Boolean(detail?.targetOrganizationSkillId);
  const diff = snapshot && current ? diffLines(
    `${current.name}\n${current.description}\n${current.instructions}`,
    `${snapshot.content.name}\n${snapshot.content.description}\n${snapshot.content.instructions}`
  ) : [];

  return <section className="pt-5" aria-label="Organization skill review">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Skill review</h2><p className="mt-1 text-sm text-on-surface-variant">Decide what enters your organization library.</p></div><p className="text-xs font-medium text-on-surface-variant"><strong className="text-lg text-on-surface">{pendingCount}</strong> awaiting a decision</p></div>
    {scopeError ? <div role="alert" className="mb-4 rounded-md bg-danger-surface p-4 text-sm text-danger">{expired ? "Your session expired. Sign in again and reload the page." : "Your account or organization changed. Reload before reviewing submissions."}<Button size="sm" variant="outline" className="ml-3" onClick={() => window.location.reload()}>Reload page</Button></div> : null}
    {error && !scopeError ? <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-danger-surface p-3 text-sm text-danger"><span>{error}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => { setError(null); setDetailRetry((current) => current + 1); void refresh(); }}>Refresh queue</Button></div> : null}
    {!scopeError ? <div className="grid min-h-[36rem] overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-sm lg:h-[min(74vh,60rem)] lg:grid-cols-[minmax(260px,34%)_minmax(0,1fr)]">
      <aside className={`${mobileDetail ? "hidden lg:flex" : "flex"} min-h-0 flex-col border-r border-outline-variant bg-surface-container-low`} aria-label="Review queue"><div className="p-4"><div className="flex items-baseline justify-between gap-2"><h3 ref={queueHeading} tabIndex={-1} className="font-semibold">Queue</h3><span className="text-xs text-on-surface-variant">{visible.length} shown</span></div><label htmlFor="submission-search" className="sr-only">Search submissions</label><input id="submission-search" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setExactSelection(false); setError(null); }} placeholder="Search skills or authors" className="mt-3 h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" /></div>
        <div className="flex flex-wrap gap-1 border-b border-outline-variant px-3 pb-3" role="group" aria-label="Queue filter">{(["pending", "waiting", "all", "completed"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} className={`rounded-md px-2 py-1.5 text-xs font-medium capitalize hover:bg-surface-container ${filter === value ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant"}`} onClick={() => { setFilter(value); setExactSelection(false); setError(null); setMobileDetail(false); }}>{value === "pending" ? "Needs review" : value === "waiting" ? "Waiting" : value}</button>)}</div>
        <div className="min-h-0 flex-1 overflow-auto">{loading ? <div className="space-y-2 p-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : visible.length ? visible.map((item) => <button key={item.id} ref={(node) => { queueButtons.current[item.id] = node; }} type="button" aria-current={selected?.id === item.id ? "true" : undefined} onClick={() => open(item.id)} className={`block w-full border-b border-outline-variant p-4 text-left transition-colors hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selected?.id === item.id ? "bg-primary-container/50" : ""}`}><span className="flex items-start justify-between gap-2"><strong className="min-w-0 break-words text-sm">{item.latest.snapshot.content.name}</strong><span className={`shrink-0 rounded px-1.5 py-0.5 text-[.66rem] font-semibold ${item.targetOrganizationSkillId ? "bg-info-surface text-info" : "bg-surface-container text-on-surface-variant"}`}>{item.targetOrganizationSkillId ? "Update" : "New"}</span></span><span className="mt-1 block text-xs text-on-surface-variant">{item.latest.snapshot.content.description}</span><span className="mt-2 flex flex-wrap gap-1.5 text-xs text-on-surface-variant"><span>{item.authorName}</span><span aria-hidden="true">·</span><span>{labels[item.status]}</span><span aria-hidden="true">·</span><span>{item.status === "pending" ? `Waiting ${elapsed(item.latest.submittedAt)}` : date(item.updatedAt)}</span></span></button>) : <p className="p-5 text-sm text-on-surface-variant">No submissions match this view. Try another filter or search.</p>}</div>
      </aside>
      <div className={`${mobileDetail ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col`} aria-label="Skill review detail"><button type="button" onClick={back} className="border-b border-outline-variant px-4 py-3 text-left text-sm font-medium text-primary lg:hidden">← Back to queue</button>
        <div className="min-h-0 flex-1 overflow-auto">{showDetailLoading ? <div className="space-y-4 p-6"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-20" /><Skeleton className="h-40" /></div> : currentDetail && snapshot ? <div className="mx-auto max-w-3xl p-5 pb-12 sm:p-8"><p className="text-xs text-on-surface-variant">Submission {detail.latest.attempt} · Skill review</p><div className="mt-3 flex flex-wrap items-start justify-between gap-3"><div><h3 ref={detailHeading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">{snapshot.content.name}</h3><p className="mt-2 text-sm text-on-surface-variant">{snapshot.content.description}</p>{detail.latest.note ? <p className="mt-4 text-sm"><strong>{detail.authorName} wrote:</strong> “{detail.latest.note}”</p> : null}</div><span className="rounded-md bg-warning-surface px-2 py-1 text-xs font-semibold text-warning">{labels[detail.status]}</span></div>
          <dl className="my-5 grid grid-cols-2 gap-4 border-b border-outline-variant pb-5 text-sm sm:grid-cols-4"><div><dt className="text-xs text-on-surface-variant">Submitted by</dt><dd className="mt-1 font-medium">{detail.authorName}</dd></div><div><dt className="text-xs text-on-surface-variant">Submitted</dt><dd className="mt-1 font-medium">{date(detail.latest.submittedAt)}</dd></div><div><dt className="text-xs text-on-surface-variant">Type</dt><dd className="mt-1 font-medium">{isUpdate ? "Update" : "New skill"}</dd></div><div><dt className="text-xs text-on-surface-variant">Waiting</dt><dd className="mt-1 font-medium">{detail.status === "pending" ? elapsed(detail.latest.submittedAt) : "Review complete"}</dd></div></dl>
          {isUpdate ? <p className="mb-5 rounded-md bg-info-surface p-4 text-sm">{detail.organizationSkill?.enabled ? `Current release: ${detail.organizationSkill.isPublished ? "all members" : "test users"}. ` : "No active release. "}Acceptance creates a draft. Members get this update only after an explicit release.</p> : null}
          {snapshot.validationMessages.length ? <p className="mb-5 rounded-md bg-warning-surface p-4 text-sm text-warning">This saved revision has {snapshot.validationMessages.length} validation note{snapshot.validationMessages.length === 1 ? "" : "s"}. Review them before deciding.</p> : null}
          {detail.status === "accepted" && acceptedNow && scope ? <ReleaseStep detail={detail} scope={scope} audience={audience} setAudience={setAudience} onReleased={(updated, responseScope) => { if (!check(responseScope)) return; setItems((current) => current.map((item) => item.id === updated.id ? updated : item)); if (selectedIdRef.current === updated.id) { setDetail(updated); setLoadedDetailKey(`${updated.id}:${updated.version}`); setAcceptedNow(false); } onQueueChanged?.(); }} onFailure={handleError} onRefreshAfterAttempt={() => { onQueueChanged?.(); setDetailRetry((current) => current + 1); }} onError={setError} onOpenLibrary={onOpenLibrary} /> : <>
            <div className="mb-6 flex flex-wrap gap-5 border-b border-outline-variant" role="group" aria-label="Review details">{([ ["submission", "Submitted text"], ...(isUpdate ? [["changes", "Changes"], ["current", "Current version"]] : []), ["validation", "Validation"], ["history", "History"] ] as [Tab,string][]).map(([value,label]) => <button key={value} type="button" aria-pressed={tab === value} className={`-mb-px border-b-2 pb-3 text-sm ${tab === value ? "border-primary font-semibold text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`} onClick={() => setSelectedTab({ id: selected!.id, tab: value })}>{label}</button>)}</div>
            {tab === "submission" ? <SkillDocument content={snapshot.content} /> : null}
            {tab === "current" ? <div className="space-y-6">{current ? <><p className="text-xs font-semibold text-on-surface-variant">Current active revision {detail.organizationSkill?.activeRevisionId}</p><SkillDocument content={current} /></> : <p className="text-sm text-on-surface-variant">No active organization version is available.</p>}{currentDraft && detail.organizationSkill?.currentDraftRevisionId !== detail.organizationSkill?.activeRevisionId ? <div className="border-t border-outline-variant pt-5"><p className="mb-4 text-xs font-semibold text-on-surface-variant">Latest organization draft revision {detail.organizationSkill?.currentDraftRevisionId}</p><SkillDocument content={currentDraft} /></div> : null}</div> : null}
            {tab === "changes" ? <div className="max-w-[70ch] space-y-1 text-sm"><p className="mb-4 text-on-surface-variant">Full text changes between the current organization version and this submission.</p>{current ? diff.map((line, index) => <div key={index} className={`whitespace-pre-wrap break-words rounded px-3 py-1 font-mono text-xs ${line.kind === "add" ? "bg-success-surface text-success" : line.kind === "remove" ? "bg-danger-surface text-danger" : "text-on-surface-variant"}`}><span aria-hidden="true" className="mr-2">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>{line.kind === "add" ? <span className="sr-only">Added: </span> : line.kind === "remove" ? <span className="sr-only">Removed: </span> : null}{line.text || " "}</div>) : <p>No current organization version is available for comparison.</p>}</div> : null}
            {tab === "validation" ? <div className="max-w-[70ch] text-sm"><p className="mb-4 text-on-surface-variant">These checks cover the skill format. They do not verify the advice in the instructions.</p>{snapshot.validationMessages.length ? <ul className="divide-y divide-outline-variant">{snapshot.validationMessages.map((value, index) => <li key={index} className="py-3 text-danger">{value}</li>)}</ul> : <p className="rounded-md bg-success-surface p-4 text-success">No validation warnings.</p>}</div> : null}
            {tab === "history" ? <div className="max-w-[70ch]"><ol className="divide-y divide-outline-variant">{detail.attempts.map((attempt) => <li key={attempt.attempt} className="grid gap-2 py-4 text-sm sm:grid-cols-[8rem_1fr]"><span className="text-on-surface-variant">{date(attempt.submittedAt)}</span><div><strong>Submission {attempt.attempt} · {labels[attempt.status]}</strong><p className="mt-1 text-on-surface-variant">Private revision {attempt.snapshot.sourceRevision}</p>{attempt.note ? <p className="mt-2 whitespace-pre-wrap">Author: {attempt.note}</p> : null}{attempt.feedback ? <p className="mt-2 whitespace-pre-wrap">{attempt.decidedByName ?? "Reviewer"}: {attempt.feedback}</p> : null}</div></li>)}</ol><p className="mt-4 text-xs text-on-surface-variant">The submitted text stays in this review record. Later organization edits create separate revisions.</p></div> : null}
          </>}
          {detail.status === "accepted" && !acceptedNow && detail.organizationSkill?.currentDraftRevisionId && detail.organizationSkill.currentDraftRevisionId !== detail.organizationSkill.activeRevisionId ? <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-outline-variant pt-5"><Button size="sm" onClick={() => setAcceptedNow(true)}>Release organization draft</Button>{onOpenLibrary ? <Button size="sm" variant="outline" onClick={onOpenLibrary}>Edit draft in library</Button> : null}</div> : null}
          {detail.status === "pending" && !feedbackAction ? <div className="mt-8 rounded-lg border border-outline-variant bg-surface-container-low p-4"><h4 className="font-semibold">Accept as organization draft</h4><p className="mt-1 text-xs text-on-surface-variant">Choose the library identity. Acceptance does not release the skill.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium">Skill ID<input value={organizationSkillId} disabled={busy || isUpdate} onChange={(event) => setOrganizationSkillId(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm" /></label><label className="text-xs font-medium">Library name<input value={organizationSkillName} disabled={busy || isUpdate} onChange={(event) => setOrganizationSkillName(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm" /></label></div>{isUpdate ? <p className="mt-2 text-xs text-on-surface-variant">This update belongs to {detail.targetOrganizationSkillId}. The current active revision remains in use.</p> : <p className="mt-2 text-xs text-on-surface-variant">If the ID already exists, choose another ID and try again.</p>}</div> : null}
        </div> : <div className="p-8"><h3 className="font-semibold">No submission selected</h3><p className="mt-2 text-sm text-on-surface-variant">{exactSelection && !loading ? "This submission is no longer in the review queue. Choose another item or refresh the queue." : "Choose a queue item or change the filter."}</p></div>}</div>
        {currentDetail?.status === "pending" && !acceptedNow ? <>{feedbackAction ? <div className="border-t border-outline-variant bg-surface-container-low p-4"><label htmlFor="review-feedback" className="text-sm font-semibold">{feedbackAction === "decline" ? "Reason for declining" : "What should the author change?"}</label><p className="mt-1 text-xs text-on-surface-variant">The author will see this message with the submission.</p><textarea id="review-feedback" value={feedback} disabled={busy} onChange={(event) => setFeedbackDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} className="mt-3 min-h-24 w-full rounded-md border border-outline-variant bg-surface p-3 text-sm" /><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setFeedbackAction(null)}>Cancel</Button><Button size="sm" disabled={busy || !feedback.trim()} onClick={() => void decide(feedbackAction)}>{busy ? "Sending…" : feedbackAction === "decline" ? "Decline submission" : "Send request"}</Button></div></div> : null}<div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-outline-variant bg-surface p-4"><span className="mr-auto text-xs text-on-surface-variant">Review the submitted text and validation before deciding.</span><Button size="sm" variant="outline" disabled={busy} onClick={() => setFeedbackAction("decline")}>Decline</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setFeedbackAction("request_changes")}>Request changes</Button><Button size="sm" disabled={busy} onClick={() => void decide("accept")}>{busy ? "Accepting…" : "Accept as draft"}</Button></div></> : null}
      </div>
    </div> : null}
  </section>;
}

function ReleaseStep({ detail, scope, audience, setAudience, onReleased, onFailure, onRefreshAfterAttempt, onError, onOpenLibrary }: {
  detail: OrganizationSkillSubmissionDetail;
  scope: PersonalSkillScope;
  audience: "test-users" | "members";
  setAudience: (audience: "test-users" | "members") => void;
  onReleased: (updated: OrganizationSkillSubmissionDetail, responseScope: PersonalSkillScope) => void;
  onFailure: (cause: unknown) => void;
  onRefreshAfterAttempt: () => void;
  onError: (error: string) => void;
  onOpenLibrary?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const skill = detail.organizationSkill;
  return <div className="max-w-[70ch] space-y-5"><div className="rounded-md bg-info-surface p-4 text-sm"><strong>Accepted as an organization draft.</strong><p className="mt-1">The current released version stays in place until you release this draft. The submitted text remains in review history.</p></div>{skill?.currentDraftContent ? <div className="rounded-md border border-outline-variant p-4"><p className="mb-3 text-xs font-semibold text-on-surface-variant">Organization draft · revision {skill.currentDraftRevisionId}</p><SkillDocument content={skill.currentDraftContent} /></div> : null}{onOpenLibrary ? <Button size="sm" variant="outline" onClick={onOpenLibrary}>Edit draft in library</Button> : null}<h4 className="font-semibold">Choose who can use this version</h4><fieldset className="space-y-2"><legend className="sr-only">Release audience</legend>{([ ["test-users", "Test users", "Only designated test users can select this version."], ["members", "All members", "Everyone in the organization can select this version."] ] as const).map(([value, title, description]) => <label key={value} className="flex gap-3 rounded-md border border-outline-variant p-3"><input type="radio" name="release-audience" checked={audience === value} onChange={() => setAudience(value)} /><span className="text-sm"><strong>{title}</strong><span className="mt-1 block text-xs text-on-surface-variant">{description}</span></span></label>)}</fieldset><p className="rounded-md bg-surface-container-low p-4 text-sm">Defaults include available released skills. A custom selection does not gain a new skill. A member who selected an existing skill uses its new revision if they still have access. A narrower audience can remove access for other members.</p>{skill?.currentDraftRevisionId ? <ReleaseImpactStep
    key={`${detail.id}:${skill.version}:${skill.currentDraftRevisionId}:${audience}`}
    choiceKey={`${detail.id}:${skill.version}:${skill.currentDraftRevisionId}:${audience}`}
    previewLabel={`Preview release to ${audience === "members" ? "all members" : "test users"}`}
    confirmLabel={`Confirm release to ${audience === "members" ? "all members" : "test users"}`}
    disabled={busy}
    onAccessError={onFailure}
    load={() => previewAdminSkillRelease(skill.skillId, { action: "activate", revisionId: skill.currentDraftRevisionId, audience })}
    confirm={async (snapshot) => {
      setBusy(true); onError("");
      try {
        const result = await releaseSkillSubmission(detail.id, {
          scope, expectedOrganizationVersion: skill.version, expectedActiveRevisionId: skill.activeRevisionId,
          expectedDraftRevisionId: skill.currentDraftRevisionId!, audience, expectedSnapshot: snapshot
        });
        onReleased(result.submission, result.scope);
      } catch (cause) { onFailure(cause); onRefreshAfterAttempt(); throw cause; }
      finally { setBusy(false); }
    }} /> : null}</div>;
}
