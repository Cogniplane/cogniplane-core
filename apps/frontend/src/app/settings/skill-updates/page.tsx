"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrganizationSkillSubmissionUpdate, PersonalSkillScope } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSkillUpdates, skillUpdatesKey, SkillUpdatesScopeError, type SkillUpdatesData } from "@/hooks/use-skill-updates";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import { readMySkillSubmissionUpdate } from "@/lib/organization-skill-submissions-api";

const labels: Record<OrganizationSkillSubmissionUpdate["kind"], string> = {
  changes_requested: "Changes requested", declined: "Declined", accepted: "Accepted as draft", released: "Released"
};

function description(update: OrganizationSkillSubmissionUpdate) {
  if (update.kind === "changes_requested") return "The reviewer asked you to revise this submission.";
  if (update.kind === "declined") return "The reviewer declined this submission.";
  if (update.kind === "accepted") return "The reviewer accepted this draft. An admin manages release separately.";
  return `An admin released this revision${update.audience === "test-users" ? " to test users" : update.audience === "members" ? " to members" : ""}. Later releases may have changed what is available now.`;
}

export default function SkillUpdatesPage() {
  const { user } = useAuth();
  if (!user) return null;
  return <ScopedSkillUpdates key={`${user.tenantId}:${user.userId}`} scope={{ tenantId: user.tenantId, userId: user.userId }} />;
}

function ScopedSkillUpdates({ scope }: { scope: PersonalSkillScope }) {
  const queryClient = useQueryClient();
  const list = useSkillUpdates(scope);
  const [opened, setOpened] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const alive = useRef(true);
  const readQueue = useRef(Promise.resolve());
  const queuedReads = useRef(new Set<string>());
  const accessRevoked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const updates = list.data?.updates ?? [];
  const lock = () => { accessRevoked.current = true; queryClient.removeQueries({ queryKey: skillUpdatesKey(scope), exact: true }); setLocked(true); setOpened(null); setError("Your account or organization changed. Reload this page before viewing skill updates."); };

  const open = (update: OrganizationSkillSubmissionUpdate) => {
    setOpened((current) => current === update.id ? null : update.id);
    if (update.readAt || queuedReads.current.has(update.id)) return;
    queuedReads.current.add(update.id);
    readQueue.current = readQueue.current.then(async () => {
      if (accessRevoked.current || !alive.current) { queuedReads.current.delete(update.id); return; }
      setReading(update.id);
      try {
      const result = await readMySkillSubmissionUpdate(update.id, scope);
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId || result.id !== update.id) { if (alive.current) lock(); return; }
      queryClient.setQueryData<SkillUpdatesData>(skillUpdatesKey(scope), (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({
          ...page, unreadCount: result.unreadCount,
          updates: page.updates.map((item) => item.id === update.id ? { ...item, readAt: result.readAt } : item)
        }))
      } : current);
      if (!alive.current) return;
      setError(null);
      } catch (cause) { if (alive.current) { if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) lock(); else setError(cause instanceof Error ? cause.message : "Could not mark this update as read."); } }
      finally { queuedReads.current.delete(update.id); if (alive.current) setReading(null); }
    });
  };
  const loadMore = async () => {
    if (!list.hasNextPage || list.isFetchingNextPage) return;
    setError(null);
    const result = await list.fetchNextPage();
    if (!alive.current || !result.isFetchNextPageError) return;
    const cause = result.error;
    if (cause instanceof SkillUpdatesScopeError || (cause instanceof ApiError && (cause.status === 401 || cause.status === 403))) lock();
    else setError(cause instanceof Error ? cause.message : "Could not load more updates.");
  };

  return <section className="space-y-4 pt-5" aria-labelledby="skill-updates-title">
    <div><h2 id="skill-updates-title" className="text-lg font-semibold">Recent updates</h2><p className="mt-1 text-sm text-on-surface-variant">Open an update to mark it as read.</p></div>
    {error ? <p role="alert" className="rounded-md bg-danger-surface p-3 text-sm text-danger">{error}</p> : null}
    {locked ? null : list.isError && !list.data ? <div role="alert" className="rounded-lg border border-outline-variant p-5 text-sm"><p>Could not load skill updates.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void list.refetch()}>Retry</Button></div> : list.isPending ? <div aria-label="Loading skill updates" className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : updates.length === 0 ? <p className="rounded-lg border border-dashed border-outline-variant p-6 text-sm text-on-surface-variant">No skill updates yet. When a reviewer decides or an admin releases a submitted skill, you will see it here.</p> : <>
      <ul className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface">{updates.map((update) => <li key={update.id} className={update.readAt ? "" : "bg-brand-surface"}>
        <button type="button" aria-expanded={opened === update.id} onClick={() => void open(update)} className="w-full px-4 py-3 text-left hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary">
          <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-on-surface">{update.skillName}</span><span className="text-xs text-on-surface-variant">{new Date(update.createdAt).toLocaleString()}</span></span>
          <span className="mt-1 flex items-center gap-2 text-sm"><span>{labels[update.kind]}</span>{!update.readAt ? <span className="rounded-full bg-brand px-2 py-0.5 text-xs text-on-brand">Unread</span> : null}</span>
        </button>
        {opened === update.id ? <div className="space-y-3 border-t border-outline-variant px-4 py-4 text-sm"><p>{description(update)}</p>{update.feedback ? <p className="whitespace-pre-wrap rounded-md bg-surface-container-low p-3">Reviewer feedback: {update.feedback}</p> : null}<Link className="inline-flex rounded-md font-medium text-brand-strong underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary" href={`/settings/capabilities?view=submissions&submission=${encodeURIComponent(update.submissionId)}`}>Open submission</Link>{reading === update.id ? <span className="ml-3 text-xs text-on-surface-variant">Saving read state…</span> : null}</div> : null}
      </li>)}</ul>
      {list.hasNextPage ? <Button size="sm" variant="outline" disabled={list.isFetchingNextPage} onClick={() => void loadMore()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button> : null}
    </>}
  </section>;
}
