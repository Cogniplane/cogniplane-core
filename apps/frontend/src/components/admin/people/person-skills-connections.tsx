"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminPersonAccessResponse, PersonAccessItem } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "../../../lib/admin-pii-utils";
import { getAdminPersonAccess } from "../../../lib/admin-api";
import { toErrorMessage } from "../../../lib/error-utils";
import { queryKeys } from "../../../lib/query-keys";
import { formatTimestamp } from "../../../lib/time-format";
import { PILL_AMBER, PILL_GREEN, PILL_RED } from "../../../lib/ui-tokens";
import {
  countByStatus,
  defaultStatusFilter,
  defaultsNote,
  firstBlocker,
  gateLabel,
  itemSummary,
  kindLabel,
  MEMBER_DEFAULTS_PATH,
  memberAction,
  NOT_COVERED_LABEL,
  reasonText,
  RESULT_LABEL,
  resourceHref,
  resourceLabel,
  sourceNote,
  STATUS_LABEL,
  visibleItems,
  type MemberAction,
  type StatusFilter
} from "./person-skills-connections.logic";

const STATUS_PILL = { excluded: PILL_RED, unknown: PILL_AMBER, included: PILL_GREEN } as const;
const RESULT_TEXT = {
  pass: "text-success",
  fail: "text-danger",
  unknown: "text-warning",
  not_checked: "text-on-surface-faint"
} as const;
const TEXT_LINK = "rounded-sm font-medium text-info underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";
const TEXT_BUTTON = cn(TEXT_LINK, "cursor-pointer");

type CopyTarget = Pick<MemberAction, "path" | "instruction">;
type CopyResult = { ok: true; message: string } | { ok: false; message: string; url: string };

export function PersonSkillsConnections({ tenantId, userId, firstName }: {
  tenantId: string | undefined;
  userId: string;
  firstName: string;
}) {
  // The parent mounts this tab on its first selection, so the initial request is lazy.
  // The key holds the tenant and the member, and the client rejects a result for anyone else.
  const query = useQuery({
    queryKey: queryKeys.admin.personAccess(tenantId ?? "", userId),
    queryFn: () => getAdminPersonAccess(userId, { tenantId: tenantId ?? "" }),
    enabled: Boolean(tenantId && userId)
  });
  const [copy, setCopy] = useState<CopyResult | null>(null);

  async function copyLink(action: CopyTarget) {
    const url = new URL(action.path, window.location.origin).toString();
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopy({ ok: true, message: `Link copied. Send it to ${firstName}. It opens their own settings after they sign in. ${action.instruction}` });
    } catch {
      setCopy({ ok: false, message: `Could not copy the link. Copy it here and send it to ${firstName}.`, url });
    }
  }

  let body;
  if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading skills and connections" className="flex flex-col gap-3 py-3">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
      </div>
    );
  } else if (query.isError && !query.data) {
    body = (
      <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-danger">
          Could not check skills and connections. {toErrorMessage(query.error, "")}
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  } else {
    body = (
      <AccessResult
        data={query.data}
        firstName={firstName}
        refreshing={query.isFetching}
        refreshError={query.isError ? query.error : null}
        onRefresh={() => void query.refetch()}
        onCopy={(action) => void copyLink(action)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-on-surface-variant">
        Shows organization resources included in a new standalone chat. Tool permissions, policy, and service
        availability can still stop a call.
      </p>
      {/* Stays mounted so screen readers announce each copy result. */}
      <div aria-live="polite" className="empty:hidden">
        {copy ? (
          copy.ok ? (
            <p className="text-sm text-success">{copy.message}</p>
          ) : (
            <div role="alert" className="flex flex-col gap-2 text-sm">
              <p className="text-danger">{copy.message}</p>
              <Input readOnly value={copy.url} aria-label={`Settings link for ${firstName}`} onFocus={(event) => event.currentTarget.select()} />
            </div>
          )
        ) : null}
      </div>
      {body}
    </div>
  );
}

function AccessResult({ data, firstName, refreshing, refreshError, onRefresh, onCopy }: {
  data: AdminPersonAccessResponse;
  firstName: string;
  refreshing: boolean;
  refreshError: unknown;
  onRefresh: () => void;
  onCopy: (action: CopyTarget) => void;
}) {
  const counts = countByStatus(data.items);
  const [chosenFilter, setFilter] = useState<StatusFilter | null>(null);
  const [search, setSearch] = useState("");
  const filter = chosenFilter ?? defaultStatusFilter(counts);
  const items = visibleItems(data.items, filter, search);
  const otherMatches = search.trim() && filter !== "all"
    ? visibleItems(data.items, "all", search).length - items.length
    : 0;
  const emptyDefaults = data.member.defaults === "empty";
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const filters: Array<{ value: StatusFilter; label: string; count: number }> = [
    { value: "not_included", label: "Excluded or unknown", count: counts.excluded + counts.unknown },
    { value: "included", label: "Included", count: counts.included },
    { value: "all", label: "All", count: data.items.length }
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 border-b border-outline-variant pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-on-surface">New standalone chat</h3>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {defaultsNote(data.member, firstName)}{" "}
            {data.member.isTestUser ? `${firstName} has test access.` : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <time dateTime={data.checkedAt} title={formatTimestamp(data.checkedAt)} className="text-xs text-on-surface-variant tabular-nums">
            Checked {formatRelativeTime(data.checkedAt)}
          </time>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </div>

      {refreshError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-danger">
            Could not refresh. The list below is from the earlier check. {toErrorMessage(refreshError, "")}
          </p>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>Retry</Button>
        </div>
      ) : null}

      {emptyDefaults ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-container-low px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-on-surface">Resources that must be in {firstName}&apos;s defaults are excluded until {firstName} adds them.</p>
          <button
            type="button"
            className={cn(TEXT_BUTTON, "self-start text-sm sm:self-auto")}
            onClick={() => onCopy({ path: MEMBER_DEFAULTS_PATH, instruction: `${firstName} can choose them under Chat defaults.` })}
          >
            Copy settings link for {firstName}
          </button>
        </div>
      ) : null}

      <details className="group text-sm">
        <summary className="w-fit cursor-pointer rounded-sm font-medium text-on-surface outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          What this covers
        </summary>
        <div className="mt-2 max-w-prose space-y-2 text-on-surface-variant">
          <p>
            Organization skills and MCP connections, checked for a new standalone chat with the chat selection left at
            {" "}{firstName}&apos;s defaults. Included means the agent gets the resource. It does not prove that a call
            to the service will work, and a connection can be included with no allowed tools.
          </p>
          {data.notCovered.length > 0 ? (
            <>
              <p>Not covered:</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {data.notCovered.map((key) => <li key={key}>{NOT_COVERED_LABEL[key]}</li>)}
              </ul>
            </>
          ) : null}
        </div>
      </details>

      {data.items.length === 0 ? (
        <p className="py-3 text-sm text-on-surface-faint">The organization has no skills or MCP connections to check.</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {filters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    filter === option.value
                      ? "bg-surface-container font-medium text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                  )}
                >
                  {option.label} <span className="tabular-nums text-on-surface-faint">{option.count}</span>
                </button>
              ))}
            </div>
            <div className="md:w-56">
              <label htmlFor={searchId} className="sr-only">Search skills and connections</label>
              <Input ref={searchRef} id={searchId} type="search" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
          </div>
          <p className="text-xs text-on-surface-variant tabular-nums">
            {counts.excluded} excluded, {counts.unknown} unknown, {counts.included} included
          </p>

          {items.length === 0 ? (
            <div role="status" className="space-y-2 py-3 text-sm text-on-surface-variant">
              {search.trim() ? (
                <>
                  <p>
                    No {filter === "not_included" ? "excluded or unknown " : filter === "included" ? "included " : ""}
                    skills or connections match &ldquo;{search.trim()}&rdquo;.
                  </p>
                  {otherMatches > 0 ? (
                    <button type="button" className={TEXT_BUTTON} onClick={() => { setFilter("all"); searchRef.current?.focus(); }}>
                      Show {otherMatches === 1 ? "1 match" : `${otherMatches} matches`} in all resources
                    </button>
                  ) : null}
                </>
              ) : filter === "not_included" ? (
                <p>Nothing is excluded or unknown.</p>
              ) : (
                <p>Nothing is included.</p>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-outline-variant" aria-label="Skills and connections">
              {items.map((item) => (
                <AccessRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  firstName={firstName}
                  emptyDefaults={emptyDefaults}
                  onCopy={onCopy}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function AccessRow({ item, firstName, emptyDefaults, onCopy }: {
  item: PersonAccessItem;
  firstName: string;
  emptyDefaults: boolean;
  onCopy: (action: CopyTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const checksId = useId();
  const blocker = firstBlocker(item);
  const action = emptyDefaults && blocker?.reason === "not_in_member_defaults" ? null : memberAction(blocker?.reason, firstName);
  const note = sourceNote(item, firstName);

  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-on-surface">{item.name || item.id}</p>
          <p className="text-xs text-on-surface-faint">{kindLabel(item)}</p>
        </div>
        <span className={cn(STATUS_PILL[item.status], "shrink-0")}>{STATUS_LABEL[item.status]}</span>
      </div>
      <p className="text-sm text-on-surface-variant">{itemSummary(item, firstName, emptyDefaults)}</p>
      {note ? <p className="text-sm text-on-surface-variant">{note}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {action ? (
          <button type="button" className={TEXT_BUTTON} onClick={() => onCopy(action)}>{action.label}</button>
        ) : null}
        <Link href={resourceHref(item)} className={TEXT_LINK}>{resourceLabel(item)}</Link>
        {item.gates.length > 0 ? (
          <button
            type="button"
            className={cn(TEXT_BUTTON, "text-on-surface-variant")}
            aria-expanded={open}
            aria-controls={checksId}
            aria-label={`${open ? "Hide" : "Show"} checks for ${item.name || item.id}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide checks" : "Show checks"}
          </button>
        ) : null}
      </div>
      <ol id={checksId} hidden={!open} className="mt-1 flex flex-col gap-1.5 border-l-2 border-outline-variant pl-3 text-sm">
          {item.gates.map((check) => (
            <li key={check.gate} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span className={cn("shrink-0 text-xs font-semibold sm:w-28", RESULT_TEXT[check.result])}>{RESULT_LABEL[check.result]}</span>
              <span className="min-w-0 text-on-surface">
                {gateLabel(check.gate, firstName)}
                {check.reason ? <span className="block text-on-surface-variant">{reasonText(check.reason, firstName)}</span> : null}
              </span>
            </li>
          ))}
      </ol>
    </li>
  );
}
