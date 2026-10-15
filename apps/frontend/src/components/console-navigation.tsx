"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Fragment, useState } from "react";
import type { NavigationItem } from "@cogniplane/shared-types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "./ui/dialog";

export function ConsoleNavigation(input: {
  sectionLabel: string;
  ariaLabel: string;
  activeSectionId: string;
  navigationItems: readonly (NavigationItem & { group?: string })[];
  basePath: string;
}) {
  const { sectionLabel, ariaLabel, activeSectionId, navigationItems, basePath } = input;
  const [open, setOpen] = useState(false);
  const backLink = (
    <Link href="/" className="mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary">
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to app
    </Link>
  );
  const navigation = (
    <nav className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {navigationItems.map((item, index) => {
        const isActive = item.id === activeSectionId;
        return (
          <Fragment key={item.id}>
            {item.group && item.group !== navigationItems[index - 1]?.group ? (
              <p className="px-3 pb-1 pt-4 text-xs font-semibold text-on-surface-variant">{item.group}</p>
            ) : null}
            <Link href={`${basePath}/${item.id}`} onClick={() => setOpen(false)} aria-current={isActive ? "page" : undefined}
              className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary ${isActive ? "bg-brand-surface font-medium text-brand-strong" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"}`}>
              <span>{item.label}</span>
              {typeof item.count === "number" ? <span className="text-xs tabular-nums">{item.count}</span> : null}
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );

  return (
    <>
      <aside className="hidden flex-col gap-1 border-r border-outline-variant bg-surface-container-low px-3 py-4 md:flex">
        {backLink}
        <p className="px-3 pb-2 text-sm font-semibold text-on-surface">{sectionLabel}</p>
        {navigation}
      </aside>
      <div className="border-b border-outline-variant bg-surface-container-low px-4 py-3 md:hidden">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button variant="outline">{sectionLabel}: {navigationItems.find((item) => item.id === activeSectionId)?.label ?? "Sections"}</Button></DialogTrigger>
          <DialogContent className="left-0 top-0 h-dvh max-h-dvh w-80 max-w-[85vw] translate-x-0 translate-y-0 overflow-y-auto rounded-none sm:max-w-80">
            <DialogTitle>{sectionLabel}</DialogTitle>
            <DialogDescription className="sr-only">Choose a section.</DialogDescription>
            {backLink}
            {navigation}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
