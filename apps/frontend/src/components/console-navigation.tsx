"use client";

import Link from "next/link";
import { ArrowLeft, MenuIcon } from "lucide-react";
import { useId, useState } from "react";
import type { NavigationItem } from "@cogniplane/shared-types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "./ui/dialog";

type ConsoleNavigationItem = NavigationItem & { group?: string };

const LINK_FOCUS = "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Consecutive items that share a group label. Items without a group form an unlabeled group. */
function groupItems(items: readonly ConsoleNavigationItem[]): { label?: string; items: ConsoleNavigationItem[] }[] {
  const groups: { label?: string; items: ConsoleNavigationItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.label === item.group) last.items.push(item);
    else groups.push({ label: item.group, items: [item] });
  }
  return groups;
}

export function ConsoleNavigation(input: {
  sectionLabel: string;
  ariaLabel: string;
  activeSectionId: string;
  navigationItems: readonly ConsoleNavigationItem[];
  basePath: string;
}) {
  const { sectionLabel, ariaLabel, activeSectionId, navigationItems, basePath } = input;
  const [open, setOpen] = useState(false);
  const idPrefix = useId();
  const activeLabel = navigationItems.find((item) => item.id === activeSectionId)?.label ?? "Sections";

  const backLink = (
    <Link href="/" className={`mb-2 flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface md:min-h-0 ${LINK_FOCUS}`}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to app
    </Link>
  );

  // Rendered twice (rail and drawer); `scope` keeps the group label ids unique.
  const navigation = (scope: string) => (
    <nav className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {groupItems(navigationItems).map((group, groupIndex) => {
        const labelId = `${idPrefix}-${scope}-${groupIndex}`;
        return (
          <div key={group.label ?? `group-${groupIndex}`} role={group.label ? "group" : undefined} aria-labelledby={group.label ? labelId : undefined} className="flex flex-col gap-0.5">
            {group.label ? (
              <p id={labelId} className="px-3 pb-1 pt-4 text-xs font-semibold text-on-surface-variant">{group.label}</p>
            ) : null}
            {group.items.map((item) => {
              const isActive = item.id === activeSectionId;
              return (
                <Link key={item.id} href={`${basePath}/${item.id}`} onClick={() => setOpen(false)} aria-current={isActive ? "page" : undefined}
                  className={`flex min-h-10 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 ${LINK_FOCUS} ${isActive ? "bg-brand-surface font-semibold text-brand-strong" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"}`}>
                  <span className="min-w-0 truncate">{item.label}</span>
                  {typeof item.count === "number" ? <span className="text-xs tabular-nums">{item.count}</span> : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      <aside className="hidden flex-col gap-1 border-r border-outline-variant bg-surface-container-low px-3 py-4 md:flex">
        {backLink}
        <p className="px-3 pb-2 text-sm font-semibold text-on-surface">{sectionLabel}</p>
        {navigation("rail")}
      </aside>
      <div className="border-b border-outline-variant bg-surface-container-low px-4 py-2 md:hidden">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="h-10 max-w-full justify-start" aria-label={`${sectionLabel}: ${activeLabel}`}>
              <MenuIcon aria-hidden="true" />
              <span className="truncate"><span className="text-on-surface-variant">{sectionLabel}:</span> {activeLabel}</span>
            </Button>
          </DialogTrigger>
          {/* A left drawer: full height, scrolls on short screens, Escape or the backdrop closes it. */}
          <DialogContent className="left-0 top-0 h-dvh max-h-dvh w-80 max-w-[85vw] translate-x-0 translate-y-0 content-start gap-2 overflow-y-auto rounded-none border-y-0 border-l-0 pb-8 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-80 [&>[data-slot=dialog-close]]:size-10">
            <DialogTitle>{sectionLabel}</DialogTitle>
            <DialogDescription className="sr-only">Choose a section.</DialogDescription>
            {backLink}
            {navigation("drawer")}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
