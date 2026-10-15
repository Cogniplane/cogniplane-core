"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { AdminUser } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminPersonData } from "../../../hooks/use-admin-person-data";
import { useAuth } from "../../../lib/auth-context";
import { toErrorMessage } from "../../../lib/error-utils";
import { PersonAccess } from "./person-access";
import { PersonActivity } from "./person-activity";
import { PersonHeader } from "./person-header";
import { PersonSkillsConnections } from "./person-skills-connections";
import {
  PERSON_TAB_PARAM,
  personTabFromParam,
  personTabHref,
  SKILLS_CONNECTIONS_TAB
} from "./person-skills-connections.logic";

function firstName(person: AdminUser): string {
  return person.displayName?.trim().split(/\s+/)[0] || "this person";
}

function BackLink() {
  return (
    <Link
      href="/admin/users"
      className="inline-flex items-center gap-1 rounded-sm text-sm text-on-surface-variant outline-none hover:text-on-surface focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden="true">←</span> People
    </Link>
  );
}

export function PersonWorkbench({ userId }: { userId: string }) {
  const { user } = useAuth();
  const { people, person, usage, sessions } = useAdminPersonData(userId);
  const actor = { userId: user?.userId ?? "", role: user?.role ?? "member" } as const;
  // The URL owns the tab, so a direct link and back/forward select it.
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab = personTabFromParam(params.get(PERSON_TAB_PARAM));
  const [skillsVisited, setSkillsVisited] = useState(tab === SKILLS_CONNECTIONS_TAB);
  if (tab === SKILLS_CONNECTIONS_TAB && !skillsVisited) setSkillsVisited(true);
  const selectTab = (value: string) => {
    const next = personTabFromParam(value);
    if (next === tab) return;
    router.push(personTabHref(pathname, new URLSearchParams(params.toString()), next), { scroll: false });
  };

  let body: ReactNode;
  if (people.isPending) {
    body = (
      <div role="status" aria-label="Loading person" className="flex items-center gap-4 border-b border-outline-variant pb-6">
        <Skeleton className="size-14 rounded-xl" />
        <div className="flex flex-col gap-2"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64" /></div>
      </div>
    );
  } else if (people.isError) {
    body = (
      <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-5">
        <p className="text-sm text-danger">Could not load this person. {toErrorMessage(people.error, "")}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => void people.refetch()}>Retry</Button>
      </div>
    );
  } else if (!person) {
    body = (
      <div className="py-10">
        <h2 className="text-xl font-semibold text-on-surface">No member with this ID</h2>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
          <span className="break-all font-mono text-xs">{userId}</span> is not a member of your organization.
          They may have been removed, or the link is wrong.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild><Link href="/admin/users">Find a person</Link></Button>
      </div>
    );
  } else {
    body = (
      <>
        <PersonHeader person={person} isSelf={person.userId === actor.userId} />
        <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <Tabs value={tab} onValueChange={selectTab} activationMode="manual" className="min-w-0 gap-5">
            <TabsList variant="line" aria-label="Person details" className="h-auto w-full justify-start overflow-x-auto border-b border-outline-variant pb-1">
              <TabsTrigger value="activity" className="flex-none px-3 text-base">Activity</TabsTrigger>
              <TabsTrigger value={SKILLS_CONNECTIONS_TAB} className="flex-none px-3 text-base">Skills &amp; connections</TabsTrigger>
            </TabsList>
            {/* Load resources on first selection, then keep the investigation while viewing activity. */}
            <TabsContent value="activity" className="min-w-0">
              <PersonActivity userId={person.userId} firstName={firstName(person)} usage={usage} sessions={sessions} />
            </TabsContent>
            <TabsContent value={SKILLS_CONNECTIONS_TAB} forceMount hidden={tab !== SKILLS_CONNECTIONS_TAB} className="min-w-0">
              {skillsVisited ? <PersonSkillsConnections tenantId={user?.tenantId} userId={person.userId} firstName={firstName(person)} /> : null}
            </TabsContent>
          </Tabs>
          <PersonAccess person={person} actor={actor} />
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-5 pt-5">
      <BackLink />
      {body}
    </div>
  );
}
