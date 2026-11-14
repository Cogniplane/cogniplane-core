"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ScheduledJob, ScheduledJobRun } from "@cogniplane/shared-types";
import type { JobDraft, ScheduledJobDefaults } from "../lib/settings-console-types";
import { cronForSchedule, scheduleLabel, scheduleTime, scheduleWeekday, WEEKDAYS, type ScheduleMode } from "../lib/scheduled-job-schedule";
import { previewScheduledJob } from "../lib/settings-api";
import { useConfirmLeave } from "../hooks/use-confirm-leave";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMediumDateTime } from "../lib/time-format";
import { CHIP, PILL_GRAY, PILL_BLUE, PILL_RED, PILL_GREEN, HINT, LIST_ITEM } from "../lib/ui-tokens";

const TIME_ZONES = ["UTC", ...(Intl.supportedValuesOf?.("timeZone") ?? []).filter((zone) => zone !== "UTC")];

function runStatusPillClass(status: ScheduledJobRun["status"]): string {
  if (status === "completed") return PILL_GREEN;
  if (status === "failed") return PILL_RED;
  if (status === "running") return PILL_BLUE;
  return PILL_GRAY;
}

function nextRunLabel(job: ScheduledJob): string {
  if (!job.enabled) return "No upcoming run while paused";
  if (!job.nextRunAt) return "Next: Pending calculation";
  return `Next: ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short", timeZone: job.timeZone
  }).format(new Date(job.nextRunAt))} (${job.timeZone})`;
}

function focusInView(target: HTMLElement | null) {
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "nearest" });
}

function TimeZoneSelect(props: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)} className="h-9 w-full rounded-md border border-input bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {!TIME_ZONES.includes(props.value) ? <option value={props.value}>{props.value}</option> : null}
      {TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
    </select>
  );
}

function Preview(props: { cronExpression: string; timeZone: string; active: boolean }) {
  const [input, setInput] = useState({ cronExpression: "", timeZone: "" });
  useEffect(() => {
    if (!props.active) return;
    const timer = window.setTimeout(() => setInput({ cronExpression: props.cronExpression, timeZone: props.timeZone }), 300);
    return () => window.clearTimeout(timer);
  }, [props.active, props.cronExpression, props.timeZone]);
  const query = useQuery({
    queryKey: ["scheduled-job-preview", input.cronExpression, input.timeZone],
    queryFn: () => previewScheduledJob(input),
    enabled: props.active && Boolean(input.cronExpression && input.timeZone) &&
      input.cronExpression === props.cronExpression && input.timeZone === props.timeZone,
    retry: false
  });
  // A disabled query stays pending. An empty expression needs its own prompt.
  const empty = !props.cronExpression.trim();
  const pending = input.cronExpression !== props.cronExpression || input.timeZone !== props.timeZone || query.isPending;
  return (
    <p role="status" className="rounded-md bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant">
      {empty ? "Enter a cron expression to see the next run." : pending ? "Checking the next run..." : query.error
        ? "This schedule cannot be previewed. Check the time zone and cron expression."
        : query.data ? `Next run: ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: props.timeZone }).format(new Date(query.data))} (${props.timeZone})`
          : "No upcoming run was found."}
    </p>
  );
}

export function ScheduledJobsSection(input: {
  defaultsDraft: ScheduledJobDefaults;
  setDefaultsDraft: Dispatch<SetStateAction<ScheduledJobDefaults>>;
  jobDraft: JobDraft;
  setJobDraft: Dispatch<SetStateAction<JobDraft>>;
  editingJobId: string | null;
  expandedRunsJobId: string | null;
  jobRuns: ScheduledJobRun[];
  busyKey: string | null;
  scheduledJobs: ScheduledJob[];
  jobDirty: boolean;
  defaultsLoaded: boolean;
  defaultsLoading: boolean;
  jobsLoaded: boolean;
  runsLoaded: boolean;
  jobsRefreshing: boolean;
  runsRefreshing: boolean;
  jobsLoading: boolean;
  jobsLoadFailed: boolean;
  retryJobs: () => Promise<unknown>;
  defaultsDirty: boolean;
  resetDefaults: () => void;
  defaultsError: string | null;
  defaultsLoadFailed: boolean;
  retryDefaults: () => Promise<unknown>;
  jobError: string | null;
  listActionError: { jobId?: string; message: string } | null;
  runsLoading: boolean;
  runsError: string | null;
  retryRuns: () => Promise<unknown>;
  handleDefaultsSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleJobSubmit: (event: FormEvent<HTMLFormElement>, enabled?: boolean) => Promise<boolean>;
  handleEditJob: (job: ScheduledJob, options?: { enable?: boolean }) => void;
  handleCancelEdit: () => void;
  handleNewJob: () => void;
  handleDeleteJob: (jobId: string) => Promise<boolean>;
  handleToggleJob: (job: ScheduledJob) => void;
  handleToggleRuns: (jobId: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [deletingJob, setDeletingJob] = useState<ScheduledJob | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const formOpener = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const deleteErrorRef = useRef<HTMLParagraphElement>(null);
  const saveErrorRef = useRef<HTMLParagraphElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const defaultsSummaryRef = useRef<HTMLElement>(null);
  const runsButtons = useRef(new Map<string, HTMLButtonElement>());
  const retrySequence = useRef(0);
  const [retryFocus, setRetryFocus] = useState<{ button: HTMLButtonElement; target: () => HTMLElement | null | undefined; kind: "jobs" | "defaults" | "runs"; sequence: number } | null>(null);
  const handledRetryFocus = useRef<typeof retryFocus>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const deleteOpener = useRef<HTMLButtonElement | null>(null);
  const deletionFocus = useRef<string | null>(null);
  const deleted = useRef(false);
  const restoreFormFocus = useRef(false);
  useConfirmLeave(input.defaultsDirty || (formOpen && input.jobDirty));
  // The form opens below the list. Move focus to its heading when it opens.
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (formOpen) formHeadingRef.current?.focus();
    else if (restoreFormFocus.current) {
      restoreFormFocus.current = false;
      if (formOpener.current?.isConnected && !formOpener.current.disabled) formOpener.current.focus();
      else listHeadingRef.current?.focus();
    }
  }, [formOpen]);
  const isMutating = input.busyKey !== null && !input.busyKey.startsWith("runs-");
  const draft = input.jobDraft;
  const time = scheduleTime(draft.cronExpression);
  const weekday = scheduleWeekday(draft.cronExpression);

  const setScheduleMode = (mode: ScheduleMode) => {
    input.setJobDraft((current) => ({
      ...current,
      scheduleMode: mode,
      cronExpression: mode === "custom" ? current.cronExpression : cronForSchedule(mode, scheduleTime(current.cronExpression), scheduleWeekday(current.cronExpression))
    }));
  };
  const setTime = (next: string) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next)) return; input.setJobDraft((current) => ({
    ...current,
    cronExpression: cronForSchedule(current.scheduleMode === "weekly" ? "weekly" : "daily", next, scheduleWeekday(current.cronExpression))
  })); };
  const closeForm = () => { restoreFormFocus.current = true; input.handleCancelEdit(); setFormOpen(false); };
  const openForm = (button: HTMLButtonElement, job?: ScheduledJob, enable?: boolean) => {
    formOpener.current = button;
    if (job) input.handleEditJob(job, { enable });
    else input.handleNewJob();
    setFormOpen(true);
  };
  const deletePending = !!deletingJob && input.busyKey === `delete-${deletingJob.jobId}`;
  useLayoutEffect(() => {
    if (deletePending) deleteDialogRef.current?.focus({ preventScroll: true });
  }, [deletePending]);
  useLayoutEffect(() => {
    if (formOpen && input.busyKey === "scheduled-job") focusInView(formHeadingRef.current);
  }, [formOpen, input.busyKey]);
  useLayoutEffect(() => {
    if (input.jobError) focusInView(saveErrorRef.current);
    if (deletingJob && input.listActionError?.jobId === deletingJob.jobId) deleteErrorRef.current?.focus({ preventScroll: true });
  }, [input.jobError, input.listActionError, deletingJob]);
  const retryRead = async (button: HTMLButtonElement, retry: () => Promise<unknown>, kind: "jobs" | "defaults" | "runs", target: () => HTMLElement | null | undefined) => {
    const sequence = ++retrySequence.current;
    await retry();
    if (sequence === retrySequence.current) setRetryFocus({ button, target, kind, sequence });
  };
  useLayoutEffect(() => {
    if (!retryFocus || handledRetryFocus.current === retryFocus || retryFocus.sequence !== retrySequence.current) return;
    const pending = retryFocus.kind === "defaults" ? input.defaultsLoading : retryFocus.kind === "runs" ? input.runsLoading || input.runsRefreshing : input.jobsLoading || input.jobsRefreshing;
    if (pending) return;
    if (document.activeElement === retryFocus.button || document.activeElement === document.body) {
      focusInView(retryFocus.target() ?? null);
    }
    handledRetryFocus.current = retryFocus;
  }, [retryFocus, input.defaultsLoading, input.runsLoading, input.runsRefreshing, input.jobsLoading, input.jobsRefreshing]);
  const defaultsNotice = !input.defaultsLoaded
    ? input.defaultsLoadFailed ? "Defaults could not be loaded. Retry before creating a job." : "Loading defaults before you can create a job..."
    : input.defaultsLoadFailed ? "Defaults could not be refreshed. Showing the last loaded defaults."
      : input.defaultsLoading ? "Refreshing defaults. Showing the last loaded defaults." : null;

  return (
    <section id="scheduled-jobs" className="flex min-w-0 flex-col gap-5 pt-5 [overflow-wrap:anywhere]">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 ref={listHeadingRef} tabIndex={-1} className="scroll-m-2 text-lg font-semibold text-on-surface">Saved jobs</h2>
              <p className="mt-1 text-sm text-on-surface-variant">Review upcoming runs and manage recurring work.</p>
            </div>
            <Button type="button" disabled={isMutating || formOpen || !input.defaultsLoaded} aria-describedby={defaultsNotice ? "job-defaults-notice" : undefined} onClick={(event) => openForm(event.currentTarget)}>New job</Button>
          </div>
        </CardHeader>
        <CardContent>
          {defaultsNotice ? <div className="mb-4 flex flex-wrap items-center gap-2"><p id="job-defaults-notice" role="status" className="text-sm text-on-surface-variant">{defaultsNotice}</p>{input.defaultsLoadFailed ? <Button type="button" variant="outline" size="sm" disabled={input.defaultsLoading} onClick={(event) => void retryRead(event.currentTarget, input.retryDefaults, "defaults", () => listHeadingRef.current)}>Retry job defaults</Button> : null}</div> : null}
          {input.jobsRefreshing ? <p role="status" className="mb-3 text-sm text-on-surface-variant">Refreshing saved jobs...</p> : null}
          {input.jobsLoadFailed ? <div className="mb-3 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-danger">{input.jobsLoaded ? "Saved jobs could not be refreshed. Showing the last loaded jobs." : "Saved jobs could not be loaded."}</p><Button type="button" variant="outline" size="sm" disabled={input.jobsRefreshing} onClick={(event) => void retryRead(event.currentTarget, input.retryJobs, "jobs", () => listHeadingRef.current)}>Retry saved jobs</Button></div> : null}
          {input.jobsLoading ? <p role="status" className="text-sm text-on-surface-variant">Loading saved jobs...</p> : input.scheduledJobs.length === 0 && !input.jobsLoadFailed ? (
            <div className={`${LIST_ITEM} flex flex-col gap-1`}>
              <strong className="text-sm font-semibold text-on-surface">No scheduled jobs yet</strong>
              <p className="text-sm text-on-surface-variant">Create a job to run a prompt on a daily, weekly, or custom schedule.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {input.scheduledJobs.map((job) => (
                <div className={`${LIST_ITEM} flex flex-col gap-3 sm:flex-row sm:justify-between`} key={job.jobId}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm font-semibold text-on-surface">{job.jobName}</strong>
                      <span className={job.enabled ? PILL_GREEN : PILL_GRAY}>{job.enabled ? "On" : "Paused"}</span>
                    </div>
                    {job.pausedReason === "security_change" ? <p className="mt-1 text-sm text-on-surface-variant">Paused because your account security changed. Review the job to turn it on again.</p> : null}
                    {job.description ? <p className="mt-1 text-sm text-on-surface-variant">{job.description}</p> : null}
                    <p className="mt-2 text-sm text-on-surface-variant">{scheduleLabel(job.cronExpression)} · {job.timeZone}</p>
                    {job.cronExpression && scheduleLabel(job.cronExpression) === "Custom schedule" ? <p className="mt-1 font-mono text-sm text-on-surface-variant">{job.cronExpression}</p> : null}
                    <p className="text-sm text-on-surface-variant">{nextRunLabel(job)}</p>
                    <div id={`job-runs-${job.jobId}`} hidden={input.expandedRunsJobId !== job.jobId}>
                    {input.expandedRunsJobId === job.jobId ? (
                      <div role="region" aria-label={`Runs for ${job.jobName}`} className="mt-3 flex min-w-0 flex-col gap-2">
                        {input.runsRefreshing ? <p role="status" className={HINT}>Refreshing runs...</p> : null}
                        {input.runsError && input.runsLoaded ? <p className={HINT}>Showing the last loaded runs.</p> : null}
                        {input.runsLoading ? <p role="status" className={HINT}>Loading runs...</p> : input.runsError ? (
                          <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-danger">{input.runsError}</p><Button type="button" variant="outline" size="sm" onClick={(event) => void retryRead(event.currentTarget, input.retryRuns, "runs", () => runsButtons.current.get(job.jobId))}>Retry runs</Button></div>
                        ) : input.jobRuns.length === 0 ? <p className={HINT}>No runs recorded yet</p> : null}
                        {!input.runsLoading ? input.jobRuns.map((run) => (
                          <div key={run.runId} className="rounded border border-outline-variant bg-surface-container-low p-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={runStatusPillClass(run.status)}>{run.status}</span>
                              <span className={CHIP}>{formatMediumDateTime(run.startedAt, "Not scheduled yet")}</span>
                              {run.durationMs != null ? <span className={CHIP}>{(run.durationMs / 1000).toFixed(1)}s</span> : null}
                            </div>
                            {run.status === "failed" && run.errorMessage ? <p className="mt-1 text-xs text-danger">{run.errorMessage}</p> : null}
                            {run.status === "skipped" && run.errorMessage ? <p className="mt-1 text-xs text-on-surface-variant">{run.errorMessage}</p> : null}
                            {run.summary ? <p className="mt-1 text-xs text-on-surface-variant">{run.summary}</p> : null}
                          </div>
                        )) : null}
                      </div>
                    ) : null}
                    </div>
                    {input.listActionError?.jobId === job.jobId && deletingJob?.jobId !== job.jobId ? <p role="alert" className="mt-2 text-sm text-danger">{input.listActionError.message}</p> : null}

                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <Button type="button" variant="outline" size="sm" ref={(node) => { if (node) editButtons.current.set(job.jobId, node); else editButtons.current.delete(job.jobId); }} disabled={isMutating || formOpen} onClick={(event) => openForm(event.currentTarget, job)}>Edit</Button>
                    <Button type="button" variant="outline" size="sm" ref={(node) => { if (node) runsButtons.current.set(job.jobId, node); else runsButtons.current.delete(job.jobId); }} aria-expanded={input.expandedRunsJobId === job.jobId} aria-controls={`job-runs-${job.jobId}`} disabled={input.busyKey === `runs-${job.jobId}`} onClick={() => input.handleToggleRuns(job.jobId)}>{input.busyKey === `runs-${job.jobId}` ? "Loading..." : "Runs"}</Button>
                    {/* A job paused after a security change can hold a prompt that someone else wrote. Show the prompt before it runs again. */}
                    {job.pausedReason === "security_change"
                      ? <Button type="button" variant="outline" size="sm" disabled={isMutating || formOpen} onClick={(event) => openForm(event.currentTarget, job, true)}>Review</Button>
                      : <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => input.handleToggleJob(job)}>{input.busyKey === `toggle-${job.jobId}` ? "Updating..." : job.enabled ? "Disable" : "Enable"}</Button>}
                    <Button type="button" variant="ghost" size="sm" disabled={isMutating || formOpen} onClick={(event) => { deleteOpener.current = event.currentTarget; deleted.current = false; setDeletingJob(job); }}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {formOpen ? <Card>
        <CardHeader>
          <h2 ref={formHeadingRef} tabIndex={-1} className="scroll-m-2 text-lg font-semibold text-on-surface">{input.editingJobId ? "Edit job" : "New job"}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">The prompt runs at the time you choose. Your organization policies still apply.</p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            const submitter = (event.nativeEvent as SubmitEvent).submitter;
            const enabled = submitter instanceof HTMLButtonElement && submitter.name === "enabled" && submitter.value === "true";
            setSavingEnabled(enabled);
            void input.handleJobSubmit(event, enabled).then((saved) => { if (saved) { restoreFormFocus.current = true; setFormOpen(false); } });
          }}>
            <fieldset disabled={isMutating} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><Label htmlFor="job-name">Job name</Label><Input id="job-name" required value={draft.jobName} onChange={(event) => input.setJobDraft((current) => ({ ...current, jobName: event.target.value }))} placeholder="Morning digest" /></div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="job-tz">Time zone</Label><TimeZoneSelect id="job-tz" value={draft.timeZone} onChange={(timeZone) => input.setJobDraft((current) => ({ ...current, timeZone }))} /></div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-mode">Schedule</Label><select id="schedule-mode" value={draft.scheduleMode} onChange={(event) => setScheduleMode(event.target.value as ScheduleMode)} className="h-9 rounded-md border border-input bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="custom">Custom</option></select></div>
                {draft.scheduleMode !== "custom" ? <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-time">Time</Label><Input id="schedule-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></div> : null}
              </div>
              {draft.scheduleMode === "weekly" ? <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-day">Day</Label><select id="schedule-day" value={weekday} onChange={(event) => input.setJobDraft((current) => ({ ...current, cronExpression: cronForSchedule("weekly", scheduleTime(current.cronExpression), Number(event.target.value)) }))} className="h-9 rounded-md border border-input bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring">{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div> : null}
              {draft.scheduleMode === "custom" ? <details className="rounded-md border border-outline-variant px-3 py-2" open><summary className="cursor-pointer text-sm font-medium">Advanced schedule</summary><div className="mt-3 flex flex-col gap-1.5"><Label htmlFor="job-cron">Cron expression</Label><Input id="job-cron" required value={draft.cronExpression} onChange={(event) => input.setJobDraft((current) => ({ ...current, cronExpression: event.target.value }))} placeholder="0 9 * * 1-5" /><p className="text-xs text-on-surface-variant">Five fields: minute hour day month weekday.</p></div></details> : null}
              <Preview cronExpression={draft.cronExpression} timeZone={draft.timeZone} active={formOpen} />
              {input.jobError ? <p ref={saveErrorRef} tabIndex={-1} role="alert" className="scroll-m-2 text-sm text-danger">{input.jobError}</p> : null}
              <div className="flex flex-col gap-1.5"><Label htmlFor="job-prompt">Prompt</Label><Textarea id="job-prompt" required rows={5} value={draft.prompt} onChange={(event) => input.setJobDraft((current) => ({ ...current, prompt: event.target.value }))} /></div>
              <details className="rounded-md border border-outline-variant px-3 py-2"><summary className="cursor-pointer text-sm font-medium">More options</summary><div className="mt-3 flex flex-col gap-3"><div className="flex flex-col gap-1.5"><Label htmlFor="job-description">Description</Label><Input id="job-description" value={draft.description} onChange={(event) => input.setJobDraft((current) => ({ ...current, description: event.target.value }))} /></div></div></details>
              {input.editingJobId ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => input.setJobDraft((current) => ({ ...current, enabled: event.target.checked }))} /> Enable this job when saved</label> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={isMutating}>
                  {input.busyKey === "scheduled-job" && (!savingEnabled || input.editingJobId) ? "Saving..." : input.editingJobId ? "Update job" : "Save paused"}
                </Button>
                {!input.editingJobId ? (
                  <Button type="submit" name="enabled" value="true" variant="outline" disabled={isMutating}>
                    {input.busyKey === "scheduled-job" && savingEnabled ? "Saving..." : "Save and enable"}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" ref={cancelRef} disabled={isMutating} onClick={() => { if (input.jobDirty) setDiscardOpen(true); else closeForm(); }}>Cancel</Button>
              </div>
            </fieldset>
          </form>
        </CardContent>
      </Card> : null}

      <details className="rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3">
        <summary ref={defaultsSummaryRef} className="scroll-m-2 cursor-pointer text-sm font-semibold text-on-surface">Defaults for new jobs</summary>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void input.handleDefaultsSubmit(event)}>
          {defaultsNotice ? <p role="status" className="text-sm text-on-surface-variant">{defaultsNotice}</p> : null}
          {input.defaultsLoadFailed ? <Button type="button" variant="outline" disabled={input.defaultsLoading} onClick={(event) => void retryRead(event.currentTarget, input.retryDefaults, "defaults", () => defaultsSummaryRef.current)}>Retry defaults load</Button> : null}
          <fieldset disabled={isMutating || !input.defaultsLoaded} className="flex min-w-0 flex-col gap-4">
            {input.defaultsError ? <div className="flex items-center gap-2"><p role="alert" className="text-sm text-danger">{input.defaultsError}</p></div> : null}
            <div className="flex flex-col gap-1.5"><Label htmlFor="default-tz">Default time zone</Label><TimeZoneSelect id="default-tz" value={input.defaultsDraft.defaultTimeZone} onChange={(defaultTimeZone) => input.setDefaultsDraft((current) => ({ ...current, defaultTimeZone }))} /></div>
            {input.defaultsDirty ? <p role="status" className="text-sm text-on-surface-variant">Unsaved changes</p> : null}
            <div className="flex flex-wrap gap-2"><Button type="submit" disabled={isMutating || !input.defaultsDirty}>{input.busyKey === "scheduled-job-defaults" ? "Saving..." : "Save defaults"}</Button><Button type="button" variant="ghost" disabled={isMutating || !input.defaultsDirty} onClick={input.resetDefaults}>Cancel defaults</Button></div>
          </fieldset>
        </form>
      </details>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="[overflow-wrap:anywhere]" onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreFormFocus.current) return; if (formOpen) cancelRef.current?.focus(); else if (formOpener.current?.isConnected) formOpener.current.focus(); }}>
          <AlertDialogHeader><AlertDialogTitle>Discard job changes?</AlertDialogTitle><AlertDialogDescription>Your changes to this job have not been saved.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><Button type="button" variant="destructive" onClick={() => { setDiscardOpen(false); closeForm(); }}>Discard changes</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deletingJob !== null} onOpenChange={(open) => { if (!open && !deletePending) setDeletingJob(null); }}>
        <AlertDialogContent ref={deleteDialogRef} className="[overflow-wrap:anywhere]" onEscapeKeyDown={(event) => { if (deletePending) event.preventDefault(); }} onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (deleted.current) (deletionFocus.current ? editButtons.current.get(deletionFocus.current) : listHeadingRef.current)?.focus();
          else deleteOpener.current?.focus();
        }}>
          <AlertDialogHeader><AlertDialogTitle>Delete {deletingJob?.jobName}?</AlertDialogTitle><AlertDialogDescription>This deletes the job and its run history. You cannot undo this action.</AlertDialogDescription></AlertDialogHeader>
          {deletingJob && input.listActionError?.jobId === deletingJob.jobId ? <p ref={deleteErrorRef} tabIndex={-1} role="alert" className="text-sm text-danger">{input.listActionError.message}</p> : null}
          {deletePending ? <p role="status" className="text-sm text-on-surface-variant">Deleting {deletingJob?.jobName} and its run history...</p> : null}
          <AlertDialogFooter><AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel><Button type="button" variant="destructive" disabled={isMutating} onClick={() => {
            if (!deletingJob || isMutating) return;
            const index = input.scheduledJobs.findIndex(job => job.jobId === deletingJob.jobId);
            deletionFocus.current = input.scheduledJobs[index + 1]?.jobId ?? input.scheduledJobs[index - 1]?.jobId ?? null;
            void input.handleDeleteJob(deletingJob.jobId).then((success) => { if (success) { deleted.current = true; setDeletingJob(null); } });
          }}>{deletePending ? "Deleting..." : "Confirm delete"}</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
