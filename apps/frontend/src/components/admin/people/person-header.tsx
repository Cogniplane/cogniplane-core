import type { AdminUser } from "@cogniplane/shared-types";

import { cn } from "@/lib/cn";
import { PILL_BLUE, PILL_GRAY, PILL_GREEN } from "../../../lib/ui-tokens";
import { displayName, ROLE_INFO } from "./person-access.logic";

function initials(user: Pick<AdminUser, "displayName" | "email" | "userId">): string {
  const source = user.displayName?.trim() || user.email?.split("@")[0] || user.userId;
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function PersonMonogram({ user, size = "lg" }: {
  user: Pick<AdminUser, "displayName" | "email" | "userId">;
  size?: "sm" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center bg-brand-surface font-bold text-brand-strong ring-1 ring-inset ring-brand-border",
        size === "lg" ? "size-14 rounded-xl text-lg tracking-wide" : "size-9 rounded-lg text-xs"
      )}
    >
      {initials(user)}
    </span>
  );
}

export function RolePill({ role }: { role: AdminUser["role"] }) {
  return <span className={role === "owner" ? PILL_GREEN : PILL_GRAY}>{ROLE_INFO[role].label}</span>;
}

function formatJoined(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function PersonHeader({ person, isSelf }: { person: AdminUser; isSelf: boolean }) {
  const name = displayName(person);
  const hasName = Boolean(person.displayName?.trim());
  return (
    <header className="flex flex-col gap-5 border-b border-outline-variant pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <PersonMonogram user={person} />
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold tracking-tight text-on-surface">{name}</h2>
          {hasName && person.email ? (
            <p className="mt-0.5 break-all text-sm text-on-surface-variant">{person.email}</p>
          ) : null}
          {!hasName && !person.email ? (
            <p className="mt-0.5 text-sm text-on-surface-variant">No name or email on record.</p>
          ) : null}
          <p className="mt-1 break-all font-mono text-xs text-on-surface-faint">{person.userId}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <RolePill role={person.role} />
        {person.isBetaTester ? <span className={PILL_BLUE}>Test user</span> : null}
        {isSelf ? <span className={PILL_GRAY}>You</span> : null}
        <span className="text-xs text-on-surface-variant sm:ml-2">Joined {formatJoined(person.createdAt)}</span>
      </div>
    </header>
  );
}
