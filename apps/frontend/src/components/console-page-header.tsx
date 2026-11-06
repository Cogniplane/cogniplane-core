"use client";

import { AccountMenu, type AccountMenuDestination } from "./account-menu";
import { QuickJump } from "./quick-jump/quick-jump";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/cn";

/**
 * The page header of the console screens (Admin, Settings, Artifacts,
 * Projects, Archived sessions). The h1 names the page; the navigation rail or
 * the account menu gives the wider location, so there is no eyebrow above it.
 */
export function ConsolePageHeader(props: {
  title: string;
  subtitle?: string;
  destinations: readonly AccountMenuDestination[];
  className?: string;
}) {
  return (
    <header className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2", props.className)}>
      <h1 className="min-w-0 self-center text-xl font-semibold tracking-tight text-on-surface [overflow-wrap:anywhere] sm:text-2xl">
        {props.title}
      </h1>
      <div className="flex items-center gap-1.5 sm:gap-2">
        <QuickJump className="size-10 sm:h-8 sm:w-auto" />
        <ThemeToggle className="size-10 sm:size-8" />
        <AccountMenu destinations={props.destinations} triggerClassName="size-10 sm:size-8" />
      </div>
      {props.subtitle ? (
        <p className="col-span-2 max-w-2xl text-sm text-on-surface-variant sm:col-span-1">{props.subtitle}</p>
      ) : null}
    </header>
  );
}
