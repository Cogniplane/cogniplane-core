"use client";

import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { OverviewRow } from "../../../components/admin/overview-row";
import { RecentAdminChanges } from "../../../components/admin/history/history-widgets";
import { isModelEnabled } from "@cogniplane/shared-types";
import { useQuery } from "@tanstack/react-query";
import { getAdminModelCatalog, getTenantSettings, listAdminMcpServers, listAdminSkills, listAdminSessions } from "../../../lib/admin-api";
import { useAuth } from "../../../lib/auth-context";
import { listAdminSkillSubmissions } from "../../../lib/organization-skill-submissions-api";
import { queryKeys } from "../../../lib/query-keys";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { useModelSpending, useUtcMonth } from "../../../hooks/use-model-spending";
import { usePolicyMonitorSummary } from "../../../hooks/use-policy-data";
import { PolicyCenterRoutine } from "../../../components/admin/policy/policy-center-routine";
import { budgetItems, budgetRoutineLine, connectionItems, modelItems, submissionItems, type WorkItem } from "./work-queue";

function QueueRow({ item }: { item: WorkItem }) {
  return <li className="flex flex-col gap-3 border-b border-outline-variant py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0 break-words">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold text-on-surface">{item.title}</h3>
        {item.meta ? <span className="text-xs text-on-surface-variant">{item.meta}</span> : null}
      </div>
      <p className="mt-1 text-sm leading-6 text-on-surface-variant">{item.detail}</p>
    </div>
    <Button variant="outline" size="sm" asChild><Link href={item.href}>{item.action}</Link></Button>
  </li>;
}

function CheckError({ label, retry, retryLabel = `Retry ${label}` }: { label: string; retry: () => void; retryLabel?: string }) {
  return <li className="flex flex-col gap-3 border-b border-outline-variant py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
    <p className="text-sm text-danger">Could not check {label}.</p>
    <Button variant="outline" size="sm" onClick={retry}>{retryLabel}</Button>
  </li>;
}

export default function AdminOverviewPage() {
  const { user } = useAuth();
  const scopeKey = [user?.tenantId ?? "", user?.userId ?? ""];
  const settings = useQuery({ queryKey: queryKeys.admin.tenantSettings(), queryFn: getTenantSettings });
  const models = useQuery({ queryKey: queryKeys.models.adminCatalog(), queryFn: getAdminModelCatalog });
  const connections = useQuery({ queryKey: queryKeys.admin.mcpServers(), queryFn: listAdminMcpServers });
  const submissions = useQuery({
    queryKey: queryKeys.admin.skillSubmissions(scopeKey[0], scopeKey[1]), enabled: Boolean(user?.tenantId && user?.userId),
    queryFn: async () => {
      const result = await listAdminSkillSubmissions();
      if (result.scope.tenantId !== user?.tenantId || result.scope.userId !== user?.userId) throw new Error("Submission scope changed");
      return result.submissions;
    }
  });
  const skills = useQuery({ queryKey: queryKeys.admin.skills(), queryFn: listAdminSkills });
  const failures = useQuery({
    queryKey: [...queryKeys.admin.sessions({ status: "errored", limit: 5 }), "overview"],
    queryFn: () => listAdminSessions({ status: "errored", limit: 5 })
  });
  const monitoring = settings.data?.policyEnforcementMode === "monitor";
  const monitorSummary = usePolicyMonitorSummary({ enabled: monitoring });
  const month = useUtcMonth();
  const budget = useModelSpending(month);
  // Only the summary matters here. A failed "Load more" on the Usage page does not make it stale.
  const budgetFailed = budget.isError && !budget.isFetchNextPageError;
  const budgetSummary = budgetFailed ? undefined : budget.data?.pages[0];
  const budgetWork = budgetSummary ? budgetItems(budgetSummary) : [];
  const review = submissions.data ? submissionItems(submissions.data) : [];
  const connectionWork = connections.data ? connectionItems(connections.data, settings.data) : [];
  const modelWork = models.data && settings.data ? modelItems(models.data, settings.data) : [];
  const pending = submissions.isPending || connections.isPending || models.isPending || settings.isPending || budget.isPending;
  const failed = submissions.isError || connections.isError || models.isError || settings.isError || budgetFailed;
  const workCount = budgetWork.length + review.length + connectionWork.length + modelWork.length;
  const hasWork = workCount > 0;
  const readyModelCount = models.data?.models.filter((model) => settings.data && isModelEnabled(model, settings.data)
    && models.data.providers.some((provider) => provider.id === model.provider && provider.keySource !== "none")).length ?? 0;
  const orgSkillCount = skills.data?.filter((skill) => !skill.isInherited).length ?? 0;
  const drafts = skills.data?.filter((skill) => !skill.isInherited && (!skill.activeRevisionId || (skill.pendingRevisionCount ?? 0) > 0)) ?? [];

  const failureCount = failures.data?.items.length ?? 0;

  return <div className="space-y-8 pt-7">
    <section aria-labelledby="attention-heading">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 id="attention-heading" className="text-xl font-semibold tracking-tight text-on-surface">Needs attention</h2>
        {!pending && !failed && hasWork ? <span className="rounded bg-warning-surface px-2 py-0.5 text-xs font-semibold text-warning">{workCount}</span> : null}
      </div>
      {budgetWork.length ? <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Model budget</h3><ul>{budgetWork.map((item) => <QueueRow key={item.id} item={item} />)}</ul></div> : null}
      {review.length ? <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Skill submissions</h3><ul>{review.map((item) => <QueueRow key={item.id} item={item} />)}</ul></div> : null}
      {connectionWork.length ? <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Connections</h3><ul>{connectionWork.map((item) => <QueueRow key={item.id} item={item} />)}</ul></div> : null}
      {modelWork.length ? <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Models</h3><ul>{modelWork.map((item) => <QueueRow key={item.id} item={item} />)}</ul></div> : null}
      {pending ? <div role="status" aria-label="Checking work queue" className="space-y-3 py-6"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-4 w-3/5" /></div> : null}
      {failed ? <ul aria-label="Checks that need a retry" className="mt-4 rounded-lg bg-surface-container-low px-4">
        {submissions.isError ? <CheckError label="skill submissions" retry={() => void submissions.refetch()} /> : null}
        {connections.isError ? <CheckError label="connections" retry={() => void connections.refetch()} /> : null}
        {models.isError ? <CheckError label="models" retry={() => void models.refetch()} /> : null}
        {settings.isError ? <CheckError label="organization settings" retry={() => void settings.refetch()} /> : null}
        {budgetFailed ? <CheckError label="the model budget" retryLabel="Retry budget check" retry={() => void budget.refetch()} /> : null}
      </ul> : null}
      {!pending && !failed && !hasWork ? <p className="mt-2 flex items-center gap-2 text-sm text-on-surface-variant"><CheckIcon aria-hidden="true" className="size-4 text-success" />Nothing needs attention.</p> : null}
    </section>

    <section aria-labelledby="status-heading" className="border-t border-outline-variant">
      <h2 id="status-heading" className="sr-only">Status</h2>
      <div className="divide-y divide-outline-variant">
        <OverviewRow title="Models" busy={models.isPending || settings.isPending} status={models.isError || settings.isError ? "Could not check model availability." : models.isPending || settings.isPending ? "Checking model availability..." : `${readyModelCount} model${readyModelCount === 1 ? "" : "s"} ready to use.`}>
          <Button variant="outline" size="sm" asChild><Link href="/admin/models">Manage models</Link></Button>
        </OverviewRow>
        <OverviewRow title="Model budget" busy={budget.isPending} status={budgetFailed ? "Could not check the model budget." : budget.isPending ? "Checking the model budget..." : budgetSummary ? budgetRoutineLine(budgetSummary, month) : null}>
          <Button variant="outline" size="sm" asChild><Link href="/admin/token-usage">Manage budget</Link></Button>
        </OverviewRow>
        <OverviewRow title="Connections" busy={connections.isPending} status={connections.isError ? "Could not check connections." : connections.isPending ? "Checking connections..." : `${connections.data?.length ?? 0} registered connection${connections.data?.length === 1 ? "" : "s"}.`}>
          <Button variant="outline" size="sm" asChild><Link href="/admin/connections">Manage connections</Link></Button>
        </OverviewRow>
        <OverviewRow title="Skill library" busy={skills.isPending} status={skills.isError ? "Could not check the library." : skills.isPending ? "Checking the library..." : `${orgSkillCount} organization skill${orgSkillCount === 1 ? "" : "s"}.${drafts.length ? ` ${drafts.length} ${drafts.length === 1 ? "draft needs" : "drafts need"} review.` : ""}`}>
          {skills.isError ? <Button variant="outline" size="sm" onClick={() => void skills.refetch()}>Retry library</Button> : null}
          <Button variant="outline" size="sm" asChild><Link href="/admin/skills">Manage library</Link></Button>
        </OverviewRow>
        <PolicyCenterRoutine settings={settings} summary={monitorSummary} />
        <OverviewRow title="Session failures" busy={failures.isPending} status={failures.isError ? "Could not check sessions with errors." : failures.isPending ? "Checking sessions..." : failureCount ? `${failureCount}${failures.data?.nextCursor ? "+" : ""} session${failureCount === 1 && !failures.data?.nextCursor ? " has" : "s have"} errors.` : "No sessions have errors."}>
          {failures.isError ? <Button variant="outline" size="sm" onClick={() => void failures.refetch()}>Retry session check</Button> : null}
          <Button variant="outline" size="sm" asChild><Link href="/admin/sessions?status=errored">View failures</Link></Button>
        </OverviewRow>
        <RecentAdminChanges />
      </div>
    </section>
  </div>;
}
