"use client";
import Link from "next/link";
import { HistoryIcon } from "lucide-react";
import { useRecentAdminHistory } from "../../../hooks/use-admin-history";
import { Button } from "../../ui/button";
import { OverviewRow } from "../overview-row";
import { historyHref, historyTime } from "./history-presentation";

export function RecentAdminChanges() {
  const query = useRecentAdminHistory({}, 1);
  const event = query.data?.items[0];
  return <OverviewRow title="Recent changes" busy={query.isPending} status={query.isPending ? "Checking recent changes..."
    : query.isError ? <span role="alert">Could not load recent changes.</span>
      : event ? <>Last: <Link href={historyHref(event.eventId)} className="underline decoration-outline underline-offset-4 hover:text-on-surface">{event.title}</Link> by {event.actor.name}, <time dateTime={event.createdAt}>{historyTime(event.createdAt)}</time></>
        : "No admin changes recorded yet."}>
    {query.isError ? <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry recent changes</Button> : null}
    <Button variant="outline" size="sm" asChild><Link href="/admin/history">View history</Link></Button>
  </OverviewRow>;
}

export function LastAdminChange({ section }: { section: "agent" | "policy" }) {
  const query = useRecentAdminHistory({ section }, 1);
  const event = query.isError ? undefined : query.data?.items[0];
  const label = section === "agent" ? "Last recorded settings save" : "Last recorded rules or settings change";
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
    <HistoryIcon aria-hidden="true" className="size-3.5" />
    {query.isPending ? <span role="status">Checking change history...</span>
      : query.isError ? <><span role="alert">Could not check change history.</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry history</Button></>
        : event ? <Link href={historyHref(event.eventId)} className="underline decoration-outline underline-offset-4 hover:text-on-surface">{label}: {event.actor.name}, {historyTime(event.createdAt)}</Link>
          : <span>No {section === "agent" ? "settings saves" : "rules or settings changes"} recorded yet.</span>}
  </div>;
}
