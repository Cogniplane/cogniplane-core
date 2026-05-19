"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { AdminUser } from "@cogniplane/shared-types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

function getUserDisplayName(user: AdminUser): string {
  return user.displayName ?? user.email ?? user.userId;
}

/**
 * Reads a userId from `?userId=` and scrolls that row into view, briefly
 * highlighting it. Returns the userId so the caller can mark the row.
 * Defensive: bails on SSR (no document) and on missing rows. The
 * highlight is a one-shot — clears after 2.5s so the user's eye notices
 * it without leaving a permanent mark when they keep using the page.
 */
function useFocusUser(userIds: string[]): string | null {
  const params = useSearchParams();
  const userId = params.get("userId");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // The effect must re-run when the users list arrives — deep-linking with
  // a fresh page load means the data fetch hasn't resolved on first render,
  // so document.getElementById would miss. Depending on the encoded user
  // list (not the array reference) re-runs the effect exactly once when
  // the row count changes.
  const usersKey = userIds.join("|");

  useEffect(() => {
    if (!userId) return;
    if (typeof document === "undefined") return;
    const el = document.getElementById(`user-${userId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // setState is bookkeeping for the DOM scroll side effect above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedId(userId);
    const timer = window.setTimeout(() => setHighlightedId(null), 2500);
    return () => window.clearTimeout(timer);
  }, [userId, usersKey]);

  return highlightedId;
}

function getRolePillClass(role: AdminUser["role"]): string {
  switch (role) {
    case "owner":
      return PILL_GREEN;
    case "admin":
    default:
      return PILL_GRAY;
  }
}

export function AdminUsersSection(props: {
  users: AdminUser[];
  busyKey: string | null;
  onSetBetaTester: (userId: string, isBetaTester: boolean) => void;
}) {
  const betaTesters = props.users.filter((u) => u.isBetaTester).length;
  const highlightedId = useFocusUser(props.users.map((u) => u.userId));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Access</p>
            <h2 className="text-lg font-semibold text-on-surface">User management</h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              Manage user access levels. Beta testers can access unpublished skills and MCP
              servers before they are rolled out to all users.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={PILL_GRAY}>{props.users.length} known users</span>
            {betaTesters > 0 ? (
              <span className={PILL_GRAY}>
                {betaTesters} beta tester{betaTesters !== 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {props.users.length === 0 ? (
          <p className={HINT}>
            No users have signed in yet. Users appear here once they have accessed the workspace.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {props.users.map((user) => {
              const isBusy = props.busyKey === `beta-tester-${user.userId}`;
              const isHighlighted = highlightedId === user.userId;
              return (
                <div
                  className={`${LIST_ITEM} ${isHighlighted ? "outline-2 outline-offset-4 outline-accent" : ""}`}
                  key={user.userId}
                  id={`user-${user.userId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-semibold text-on-surface">
                      {getUserDisplayName(user)}
                    </strong>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={getRolePillClass(user.role)}>{user.role}</span>
                      {user.isBetaTester ? (
                        <span className={PILL_GREEN}>beta tester</span>
                      ) : null}
                    </div>
                  </div>
                  {user.email ? (
                    <p className="mt-1 text-xs text-on-surface-faint">{user.email}</p>
                  ) : null}
                  <p className="text-xs text-on-surface-faint">{user.userId}</p>

                  <label className="mt-2 inline-flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={user.isBetaTester}
                      disabled={isBusy}
                      onChange={(event) =>
                        props.onSetBetaTester(user.userId, event.target.checked)
                      }
                      className="size-4 rounded border-outline-variant accent-primary"
                    />
                    <span>Beta tester — access to unpublished skills and MCP servers</span>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
