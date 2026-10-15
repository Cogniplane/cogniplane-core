"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminUser } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { listAdminUsers } from "../../../lib/admin-api";
import { toErrorMessage } from "../../../lib/error-utils";
import { queryKeys } from "../../../lib/query-keys";
import { PILL_BLUE } from "../../../lib/ui-tokens";
import { displayName } from "./person-access.logic";
import { PersonMonogram, RolePill } from "./person-header";

export function personHref(userId: string): string {
  return `/admin/users/${encodeURIComponent(userId)}`;
}

export function matchesPerson(user: AdminUser, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [user.displayName, user.email, user.userId].some((field) => field?.toLowerCase().includes(needle));
}

function PersonRow({ user }: { user: AdminUser }) {
  const name = displayName(user);
  const secondary = user.displayName?.trim() ? user.email : null;
  return (
    <li>
      <Link
        href={personHref(user.userId)}
        className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 outline-none transition-colors hover:bg-surface-container-low focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PersonMonogram user={user} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-on-surface group-hover:underline group-hover:underline-offset-4">{name}</span>
          <span className="block truncate text-xs text-on-surface-variant">{secondary ?? user.userId}</span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {user.isBetaTester ? <span className={PILL_BLUE}>Test user</span> : null}
          <RolePill role={user.role} />
        </span>
        <span aria-hidden="true" className="text-on-surface-faint transition-transform group-hover:translate-x-0.5">›</span>
      </Link>
    </li>
  );
}

export function PeopleDirectory() {
  const [search, setSearch] = useState("");
  const searchId = useId();
  const people = useQuery({ queryKey: queryKeys.admin.users(), queryFn: listAdminUsers });
  const users = useMemo(() => people.data ?? [], [people.data]);
  const shown = useMemo(() => users.filter((user) => matchesPerson(user, search)), [users, search]);
  const testUsers = users.filter((user) => user.isBetaTester).length;

  return (
    <section aria-labelledby="people-heading" className="flex flex-col gap-4 pt-5">
      <div className="flex flex-col gap-3 border-b border-outline-variant pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="people-heading" className="text-xl font-semibold tracking-tight text-on-surface">People</h2>
          {people.data ? (
            <p className="mt-1 text-sm text-on-surface-variant">
              {users.length} {users.length === 1 ? "member" : "members"}
              {testUsers > 0 ? `, ${testUsers} with test access` : ""}. Open a person to see their activity and change their access.
            </p>
          ) : null}
        </div>
        <div className="w-full sm:w-72">
          <label htmlFor={searchId} className="sr-only">Search people</label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search by name, email, or ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={!people.data}
          />
        </div>
      </div>

      {people.isPending ? (
        <div role="status" aria-label="Loading people" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : null}

      {people.isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-danger">Could not load people. {toErrorMessage(people.error, "")}</p>
          <Button variant="outline" size="sm" onClick={() => void people.refetch()}>Retry</Button>
        </div>
      ) : null}

      {people.data && users.length === 0 ? (
        <p className="py-6 text-sm text-on-surface-faint">No one has signed in yet. People appear here after their first sign-in.</p>
      ) : null}

      {people.data && users.length > 0 ? (
        shown.length === 0 ? (
          <p role="status" className="py-6 text-sm text-on-surface-variant">No one matches &quot;{search.trim()}&quot;.</p>
        ) : (
          <ul aria-label="People" className="divide-y divide-outline-variant">
            {shown.map((user) => <PersonRow key={user.userId} user={user} />)}
          </ul>
        )
      ) : null}
    </section>
  );
}
