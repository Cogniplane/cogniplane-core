"use client";

import Image from "next/image";
import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/cn";
import { AUTH_FOCUS_RING, AUTH_SCOPE_ATTRIBUTE, focusIfOwned } from "./auth-ui";

type TaskHeadingLevel = 2 | 3 | 4;

// The level of a task heading under its parent heading: h2 under the auth
// page h1, h4 under a settings h3.
const TaskHeadingLevel = createContext<TaskHeadingLevel>(2);

export function AuthFrame({ title, children, focusKey, headingRef }: {
  title: string;
  children: ReactNode;
  /** A change moves focus to the title, for example when a result replaces a form. */
  focusKey?: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  const previousFocusKey = useRef(focusKey);
  useEffect(() => {
    if (focusKey !== undefined && focusKey !== previousFocusKey.current) focusIfOwned(heading.current);
    previousFocusKey.current = focusKey;
  }, [focusKey, heading]);
  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-4 py-12 sm:py-20">
      <div {...{ [AUTH_SCOPE_ATTRIBUTE]: "" }} className="w-full max-w-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 sm:p-8">
        <div className="mb-7 flex items-center gap-2.5">
          <Image src="/brand/cogniplane.svg" alt="" width={32} height={32} priority />
          <span className="font-heading text-sm font-semibold text-on-surface">Cogniplane</span>
        </div>
        <h1 ref={heading} tabIndex={-1} className={cn("mb-6 w-fit max-w-full rounded-sm text-2xl font-semibold tracking-tight text-on-surface", AUTH_FOCUS_RING)}>{title}</h1>
        <TaskHeadingLevel.Provider value={2}>{children}</TaskHeadingLevel.Provider>
      </div>
    </main>
  );
}

/**
 * An auth task inside another page, such as settings. It sets the task
 * heading level below the parent heading and owns focus for the task.
 */
export function AuthTaskScope({ level, className, children }: { level: TaskHeadingLevel; className?: string; children: ReactNode }) {
  return (
    <TaskHeadingLevel.Provider value={level}>
      <div {...{ [AUTH_SCOPE_ATTRIBUTE]: "" }} className={cn("flex min-w-0 flex-col gap-3", className)}>{children}</div>
    </TaskHeadingLevel.Provider>
  );
}

// Focus follows a new task, rather than every status or error update, and
// only while the task still owns focus.
export function AuthStepHeading({ children }: { children: string }) {
  const level = useContext(TaskHeadingLevel);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { focusIfOwned(ref.current); }, [children]);
  const Heading = `h${level}` as const;
  return (
    <Heading ref={ref} tabIndex={-1} className={cn("w-fit max-w-full rounded-sm font-semibold text-on-surface", level === 2 ? "text-lg" : "text-base", AUTH_FOCUS_RING)}>
      {children}
    </Heading>
  );
}
