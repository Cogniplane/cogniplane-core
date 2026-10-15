"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, HistoryIcon } from "lucide-react";
import { ADMIN_HISTORY_CATEGORIES, type AdminHistoryCategory, type AdminHistoryEvent } from "@cogniplane/shared-types";
import { useAdminHistory } from "../../../hooks/use-admin-history";
import { getAdminHistoryEvent } from "../../../lib/admin-history-api";
import { ApiError } from "../../../lib/api-client";
import { queryKeys } from "../../../lib/query-keys";
import { cn } from "../../../lib/cn";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Skeleton } from "../../ui/skeleton";
import { HISTORY_LABELS, historyDay, historyTime, versionLabel } from "./history-presentation";
import { SettingsComparison } from "./settings-comparison";

export function AdminHistoryPage() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const rawCategory = params.get("category");
  const category = ADMIN_HISTORY_CATEGORIES.find((value) => value === rawCategory);
  const eventId = params.get("event");
  const compareTo = params.get("compareTo") ?? undefined;
  const query = useAdminHistory({ category });
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const failed = query.isError && !query.isFetchNextPageError;
  const events = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((event) => [event.eventId, event])).values()];
  const groups = new Map<string, AdminHistoryEvent[]>();
  for (const event of events) {
    const day = event.createdAt.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  function url(updates: Record<string, string | undefined>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) if (value === undefined) next.delete(key); else next.set(key, value);
    return `${pathname}${next.size ? `?${next}` : ""}`;
  }
  function filter(value?: AdminHistoryCategory) {
    router.replace(url({ category: value, event: undefined, compareTo: undefined }), { scroll: false });
  }
  return <div className="flex flex-col gap-6 pt-6">
    <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div><h2 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">What changed</h2>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">Follow decisions across your organization. Open a record to see its details or compare settings.</p></div>
      <Button variant="outline" size="sm" className="self-start" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching && !query.isPending ? "Refreshing..." : "Refresh history"}</Button>
    </header>
    <div role="group" aria-label="Filter history" className="flex flex-wrap gap-2">
      {[undefined, ...ADMIN_HISTORY_CATEGORIES].map((value) => <Button key={value ?? "all"} size="sm" variant={category === value ? "default" : "outline"} aria-pressed={category === value} onClick={() => filter(value)}>{value ? HISTORY_LABELS[value] : "All changes"}</Button>)}
    </div>
    <p className="text-xs text-on-surface-variant">Newest first · All times UTC · Names reflect the current directory</p>
    {query.isPending ? <div role="status" aria-label="Loading change history" className="space-y-4"><Skeleton className="h-5 w-40" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
      : failed ? <div role="alert" className="rounded-lg border border-outline-variant p-5"><p>Could not load change history. Try again to see the recorded changes.</p><Button variant="outline" className="mt-3" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry history</Button></div>
        : events.length === 0 ? <div className="rounded-xl border border-dashed border-outline-variant px-6 py-12 text-center">
          <HistoryIcon aria-hidden="true" className="mx-auto mb-3 size-6 text-on-surface-variant" /><h3 className="font-semibold">No {category ? HISTORY_LABELS[category].toLowerCase() : "admin"} changes recorded</h3>
          <p className="mx-auto mt-2 max-w-prose text-sm text-on-surface-variant">{category ? "Try another category to see other recorded actions." : "Supported admin actions will appear here after they are recorded."}</p>
        </div> : <div className="space-y-7">{[...groups].map(([day, items]) => <section key={day} aria-label={historyDay(items[0]!.createdAt)}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{historyDay(items[0]!.createdAt)}</h3>
          <ol className="divide-y divide-outline-variant border-l border-outline-variant pl-4 sm:pl-6">{items.map((event) => <li key={event.eventId} className="relative">
            <span aria-hidden="true" className="absolute -left-[21px] top-6 size-2 rounded-full border-2 border-background bg-on-surface-variant sm:-left-[29px]" />
            <Link scroll={false} href={url({ event: event.eventId, compareTo: undefined })} onClick={(e) => { trigger.current = e.currentTarget; }}
              className="group flex items-start justify-between gap-3 rounded-md px-3 py-4 outline-none hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-ring">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-medium text-on-surface">{event.title}</span>
                <span className="text-xs text-on-surface-variant">{event.settingsVersion === null ? HISTORY_LABELS[event.category] : `Version ${event.settingsVersion}`}</span></div>
                <p className="mt-1 text-sm text-on-surface-variant">{event.actor.name} <span aria-hidden="true">·</span> <time dateTime={event.createdAt}>{historyTime(event.createdAt)}</time></p>
              </div><ArrowRightIcon aria-hidden="true" className="mt-1 size-4 shrink-0 text-on-surface-variant transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </Link>
          </li>)}</ol>
        </section>)}</div>}
    {!failed && (query.hasNextPage || query.isFetchNextPageError) ? <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : query.isFetchNextPageError ? "Retry older changes" : "Load older changes"}</Button>
      {query.isFetchNextPageError ? <p role="alert" className="text-sm text-danger">Could not load older changes. The records above are still available.</p> : null}
    </div> : null}
    <p className="border-t border-outline-variant pt-4 text-xs text-on-surface-variant">This view includes supported administrative audit events. It excludes personal activity and secret values. A missing record does not prove that no change occurred.</p>
    {eventId ? <HistoryDetail key={eventId} eventId={eventId} compareTo={compareTo}
      onCompare={(id) => router.replace(url({ compareTo: id }), { scroll: false })}
      onClose={() => router.replace(url({ event: undefined, compareTo: undefined }), { scroll: false })}
      onCloseAutoFocus={(event) => { event.preventDefault(); (trigger.current?.isConnected ? trigger.current : heading.current)?.focus(); }} /> : null}
  </div>;
}

function HistoryDetail(props: { eventId: string; compareTo?: string; onCompare: (id?: string) => void; onClose: () => void; onCloseAutoFocus: (event: Event) => void }) {
  const query = useQuery({
    queryKey: queryKeys.admin.historyDetail(props.eventId, props.compareTo),
    queryFn: ({ signal }) => getAdminHistoryEvent(props.eventId, props.compareTo, signal),
    placeholderData: keepPreviousData,
    retry: (attempt, error) => !(error instanceof ApiError && [400, 403, 404].includes(error.status)) && attempt < 2
  });
  const data = query.isError ? undefined : query.data;
  const event = data?.event;
  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent onCloseAutoFocus={props.onCloseAutoFocus}
      className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-2xl">
      <div className="flex min-h-0 flex-col">
        <DialogHeader className="border-b border-outline-variant px-5 py-5 pr-12 text-left sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{event ? HISTORY_LABELS[event.category] : "Change record"}</p>
          <DialogTitle>{event?.title ?? "Recorded change"}</DialogTitle>
          <DialogDescription>{event ? <>{event.actor.name} · <time dateTime={event.createdAt}>{historyTime(event.createdAt)}</time></> : "Read recorded details and compare settings snapshots."}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
          {query.isPending ? <p role="status">Loading change details...</p> : null}
          {query.isError ? <div role="alert"><p>{query.error instanceof ApiError && query.error.status === 404 ? "This record or comparison is not available in your organization." : "Could not load this change."}</p>
            <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => void query.refetch()}>Retry details</Button>{props.compareTo ? <Button variant="ghost" onClick={() => props.onCompare()}>Use previous record</Button> : null}</div>
          </div> : null}
          {event && data ? <>
            <dl className="space-y-3">{event.details.map((item) => <div key={item.label} className="grid gap-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-on-surface-variant">{item.label}</dt><dd className="font-medium wrap-anywhere">{item.value}</dd></div>)}</dl>
            {event.details.length === 0 && event.category !== "settings" ? <p className="text-sm text-on-surface-variant">The action was recorded. No additional details are exposed for this event.</p> : null}
            {event.type === "admin.tenant_settings.updated" ? <div className="mt-5 space-y-5">
              <VersionPicker eventId={event.eventId} value={props.compareTo} onChange={props.onCompare} />
              {query.isPlaceholderData ? <p role="status">Loading comparison...</p> : data.comparison ? <SettingsComparison comparison={data.comparison} />
                : <p className="rounded-lg bg-surface-container-low p-4 text-sm text-on-surface-variant">This is the first recorded settings snapshot. There is no earlier record to compare. You can select another recorded version above.</p>}
            </div> : null}
            <div className="mt-6 border-t border-outline-variant pt-4">
              {event.target ? <Button variant="outline" size="sm" asChild><Link href={event.target.href}>{event.target.label}</Link></Button> : null}
              <p className="mt-3 text-xs text-on-surface-variant wrap-anywhere">Record {event.eventId}. This is historical evidence, not the current configuration.</p>
            </div>
          </> : null}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function VersionPicker({ eventId, value, onChange }: { eventId: string; value?: string; onChange: (id?: string) => void }) {
  const query = useAdminHistory({ category: "settings" });
  const records = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((event) => [event.eventId, event])).values()].filter((event) => event.eventId !== eventId);
  const failed = query.isError && !query.isFetchNextPageError;
  return <div className="space-y-2">
    <label htmlFor="history-compare-version" className="block text-sm font-medium">Compare with</label>
    <select id="history-compare-version" value={value ?? ""} disabled={query.isPending || failed} onChange={(event) => onChange(event.target.value || undefined)}
      className={cn("w-full min-w-0 rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm", "focus-visible:outline-2 focus-visible:outline-primary")}>
      <option value="">Previous recorded settings</option>
      {value && !records.some((event) => event.eventId === value) ? <option value={value}>Selected record {value}</option> : null}
      {!failed ? records.map((event) => <option key={event.eventId} value={event.eventId}>{versionLabel(event)}</option>) : null}
    </select>
    {query.isPending ? <p role="status" className="text-xs text-on-surface-variant">Loading recorded versions...</p> : null}
    {failed ? <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-danger">Could not load recorded versions.</p><Button variant="ghost" size="sm" onClick={() => void query.refetch()}>Retry versions</Button></div>
      : query.hasNextPage ? <Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : query.isFetchNextPageError ? "Retry older versions" : "Load older versions"}</Button> : null}
  </div>;
}
