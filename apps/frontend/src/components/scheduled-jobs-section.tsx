"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ScheduledJob, ScheduledJobRun } from "@cogniplane/shared-types";
import type { JobDraft, ScheduledJobDefaults } from "../lib/settings-console-types";
import { cronForSchedule, scheduleLabel, scheduleTime, scheduleWeekday, WEEKDAYS, type ScheduleMode } from "../lib/scheduled-job-schedule";
import { previewScheduledJob } from "../lib/settings-api";
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

function TimeZoneSelect(props: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)} className="h-9 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
  jobsLoading: boolean;
  jobsLoadFailed: boolean;
  retryJobs: () => void;
  defaultsDirty: boolean;
  resetDefaults: () => void;
  defaultsError: string | null;
  defaultsLoadFailed: boolean;
  retryDefaults: () => void;
  jobError: string | null;
  listActionError: { jobId?: string; message: string } | null;
  runsLoading: boolean;
  runsError: string | null;
  retryRuns: () => void;
  handleDefaultsSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleJobSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  handleEditJob: (job: ScheduledJob) => void;
  handleCancelEdit: () => void;
  handleDeleteJob: (jobId: string) => void;
  handleToggleJob: (job: ScheduledJob) => void;
  handleToggleRuns: (jobId: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The form opens below the list. Move focus to its heading when it opens.
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (formOpen) formHeadingRef.current?.focus(); }, [formOpen]);
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
  const closeForm = () => { input.handleCancelEdit(); setFormOpen(false); };

  return (
    <section id="scheduled-jobs" className="flex flex-col gap-5 pt-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-on-surface">Saved jobs</h2>
              <p className="mt-1 text-sm text-on-surface-variant">Review upcoming runs and manage recurring work.</p>
            </div>
            <Button type="button" disabled={isMutating || formOpen} onClick={() => { input.handleCancelEdit(); setFormOpen(true); }}>New job</Button>
          </div>
        </CardHeader>
        <CardContent>
          {input.jobsLoading ? <p role="status" className="text-sm text-on-surface-variant">Loading saved jobs...</p> : input.jobsLoadFailed ? (
            <div className="flex items-center gap-3"><p className="text-sm text-danger">Saved jobs could not be loaded.</p><Button type="button" variant="outline" size="sm" onClick={input.retryJobs}>Retry</Button></div>
          ) : input.scheduledJobs.length === 0 ? (
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
                    {job.description ? <p className="mt-1 text-sm text-on-surface-variant">{job.description}</p> : null}
                    <p className="mt-2 text-sm text-on-surface-variant">{scheduleLabel(job.cronExpression)} · {job.timeZone}</p>
                    <p className="text-sm text-on-surface-variant">{nextRunLabel(job)}</p>
                    {input.expandedRunsJobId === job.jobId ? (
                      <div className="mt-3 flex flex-col gap-2">
                        {input.runsLoading ? <p role="status" className={HINT}>Loading runs...</p> : input.runsError ? (
                          <div className="flex items-center gap-2"><p className="text-sm text-danger">{input.runsError}</p><Button type="button" variant="outline" size="sm" onClick={input.retryRuns}>Retry runs</Button></div>
                        ) : input.jobRuns.length === 0 ? <p className={HINT}>No runs recorded yet</p> : input.jobRuns.map((run) => (
                          <div key={run.runId} className="rounded border border-outline-variant bg-surface-container-low p-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={runStatusPillClass(run.status)}>{run.status}</span>
                              <span className={CHIP}>{formatMediumDateTime(run.startedAt, "Not scheduled yet")}</span>
                              {run.durationMs != null ? <span className={CHIP}>{(run.durationMs / 1000).toFixed(1)}s</span> : null}
                            </div>
                            {run.status === "failed" && run.errorMessage ? <p className="mt-1 text-xs text-danger">{run.errorMessage}</p> : null}
                            {run.summary ? <p className="mt-1 text-xs text-on-surface-variant">{run.summary}</p> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {input.listActionError?.jobId === job.jobId ? <p role="alert" className="mt-2 text-sm text-danger">{input.listActionError.message}</p> : null}
                    {confirmDeleteId === job.jobId ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${job.jobName}`}>
                        <span className="text-sm text-danger">Delete this job and its run history?</span>
                        <Button type="button" variant="destructive" size="sm" disabled={isMutating} onClick={() => { input.handleDeleteJob(job.jobId); setConfirmDeleteId(null); }}>Confirm delete</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={isMutating || formOpen} onClick={() => { input.handleEditJob(job); setFormOpen(true); }}>Edit</Button>
                    <Button type="button" variant="outline" size="sm" disabled={input.busyKey === `runs-${job.jobId}`} onClick={() => input.handleToggleRuns(job.jobId)}>{input.busyKey === `runs-${job.jobId}` ? "Loading..." : "Runs"}</Button>
                    <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => input.handleToggleJob(job)}>{job.enabled ? "Disable" : "Enable"}</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={isMutating} onClick={() => setConfirmDeleteId(job.jobId)}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {formOpen ? <Card>
        <CardHeader>
          <h2 ref={formHeadingRef} tabIndex={-1} className="text-lg font-semibold text-on-surface">{input.editingJobId ? "Edit job" : "New job"}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">The prompt runs at the time you choose. Your organization policies still apply.</p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => { void input.handleJobSubmit(event).then((saved) => { if (saved) setFormOpen(false); }); }}>
            <fieldset disabled={isMutating} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><Label htmlFor="job-name">Job name</Label><Input id="job-name" required value={draft.jobName} onChange={(event) => input.setJobDraft((current) => ({ ...current, jobName: event.target.value }))} placeholder="Morning digest" /></div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="job-tz">Time zone</Label><TimeZoneSelect id="job-tz" value={draft.timeZone} onChange={(timeZone) => input.setJobDraft((current) => ({ ...current, timeZone }))} /></div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-mode">Schedule</Label><select id="schedule-mode" value={draft.scheduleMode} onChange={(event) => setScheduleMode(event.target.value as ScheduleMode)} className="h-9 rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="custom">Custom</option></select></div>
                {draft.scheduleMode !== "custom" ? <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-time">Time</Label><Input id="schedule-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></div> : null}
              </div>
              {draft.scheduleMode === "weekly" ? <div className="flex flex-col gap-1.5"><Label htmlFor="schedule-day">Day</Label><select id="schedule-day" value={weekday} onChange={(event) => input.setJobDraft((current) => ({ ...current, cronExpression: cronForSchedule("weekly", scheduleTime(current.cronExpression), Number(event.target.value)) }))} className="h-9 rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring">{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div> : null}
              {draft.scheduleMode === "custom" ? <details className="rounded-md border border-outline-variant px-3 py-2" open><summary className="cursor-pointer text-sm font-medium">Advanced schedule</summary><div className="mt-3 flex flex-col gap-1.5"><Label htmlFor="job-cron">Cron expression</Label><Input id="job-cron" required value={draft.cronExpression} onChange={(event) => input.setJobDraft((current) => ({ ...current, cronExpression: event.target.value }))} placeholder="0 9 * * 1-5" /><p className="text-xs text-on-surface-variant">Five fields: minute hour day month weekday.</p></div></details> : null}
              <Preview cronExpression={draft.cronExpression} timeZone={draft.timeZone} active={formOpen} />
              {input.jobError ? <p role="alert" className="text-sm text-danger">{input.jobError}</p> : null}
              <div className="flex flex-col gap-1.5"><Label htmlFor="job-prompt">Prompt</Label><Textarea id="job-prompt" required rows={5} value={draft.prompt} onChange={(event) => input.setJobDraft((current) => ({ ...current, prompt: event.target.value }))} /></div>
              <details className="rounded-md border border-outline-variant px-3 py-2"><summary className="cursor-pointer text-sm font-medium">More options</summary><div className="mt-3 flex flex-col gap-3"><div className="flex flex-col gap-1.5"><Label htmlFor="job-description">Description</Label><Input id="job-description" value={draft.description} onChange={(event) => input.setJobDraft((current) => ({ ...current, description: event.target.value }))} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => input.setJobDraft((current) => ({ ...current, enabled: event.target.checked }))} /> Enable this job when saved</label></div></details>
              <div className="flex gap-2"><Button type="submit" disabled={isMutating}>{input.busyKey === "scheduled-job" ? "Saving..." : input.editingJobId ? "Update job" : "Create job"}</Button><Button type="button" variant="ghost" disabled={isMutating} onClick={closeForm}>Cancel</Button></div>
            </fieldset>
          </form>
        </CardContent>
      </Card> : null}

      <details className="rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-on-surface">Defaults for new jobs</summary>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void input.handleDefaultsSubmit(event)}>
          <fieldset disabled={isMutating} className="flex flex-col gap-4">
            {input.defaultsError ? <div className="flex items-center gap-2"><p role="alert" className="text-sm text-danger">{input.defaultsError}</p>{input.defaultsLoadFailed ? <Button type="button" variant="outline" size="sm" onClick={input.retryDefaults}>Retry load</Button> : null}</div> : null}
            <div className="flex flex-col gap-1.5"><Label htmlFor="default-tz">Default time zone</Label><TimeZoneSelect id="default-tz" value={input.defaultsDraft.defaultTimeZone} onChange={(defaultTimeZone) => input.setDefaultsDraft((current) => ({ ...current, defaultTimeZone }))} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={input.defaultsDraft.enableOnCreate} onChange={(event) => input.setDefaultsDraft((current) => ({ ...current, enableOnCreate: event.target.checked }))} /> Enable new jobs by default</label>
            {input.defaultsDirty ? <p role="status" className="text-sm text-on-surface-variant">Unsaved changes</p> : null}
            <div className="flex gap-2"><Button type="submit" disabled={isMutating || !input.defaultsDirty}>{input.busyKey === "scheduled-job-defaults" ? "Saving..." : "Save defaults"}</Button><Button type="button" variant="ghost" disabled={isMutating || !input.defaultsDirty} onClick={input.resetDefaults}>Cancel defaults</Button></div>
          </fieldset>
        </form>
      </details>
    </section>
  );
}
