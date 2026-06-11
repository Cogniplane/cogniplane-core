import type { Dispatch, FormEvent, SetStateAction } from "react";

import type { ScheduledJob, ScheduledJobRun } from "@cogniplane/shared-types";
import type { JobDraft, ScheduledJobDefaults } from "../lib/settings-console-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMediumDateTime } from "../lib/time-format";
import { PILL_GRAY, PILL_BLUE, PILL_RED, PILL_GREEN, HINT, LIST_ITEM, SECTION_LABEL } from "../lib/ui-tokens";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

function runStatusPillClass(status: ScheduledJobRun["status"]): string {
  if (status === "completed") return PILL_GREEN;
  if (status === "failed") return PILL_RED;
  if (status === "running") return PILL_BLUE;
  return PILL_GRAY;
}

function ToggleCard(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-outline-variant accent-primary"
      />
      <div className="flex-1">
        <strong className="block text-sm font-semibold text-on-surface">{props.label}</strong>
        <small className="block text-xs text-on-surface-faint">{props.hint}</small>
      </div>
    </label>
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
  handleDefaultsSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleJobSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleEditJob: (job: ScheduledJob) => void;
  handleCancelEdit: () => void;
  handleDeleteJob: (jobId: string) => void;
  handleToggleJob: (job: ScheduledJob) => void;
  handleToggleRuns: (jobId: string) => void;
}) {
  const {
    defaultsDraft,
    setDefaultsDraft,
    jobDraft,
    setJobDraft,
    editingJobId,
    expandedRunsJobId,
    jobRuns,
    busyKey,
    scheduledJobs,
    handleDefaultsSubmit,
    handleJobSubmit,
    handleEditJob,
    handleCancelEdit,
    handleDeleteJob,
    handleToggleJob,
    handleToggleRuns
  } = input;

  return (
    <section id="scheduled-jobs" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Live module</p>
        <h3 className="text-lg font-semibold text-on-surface">Scheduled jobs</h3>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>Defaults</p>
                <h2 className="text-lg font-semibold text-on-surface">Scheduled job defaults</h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Save default values once so new jobs open with your preferred time zone and
                  enabled state.
                </p>
              </div>
              <span className={PILL_GRAY}>sectioned config</span>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void handleDefaultsSubmit(event)}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="default-tz">Default time zone</Label>
                <Input
                  id="default-tz"
                  placeholder="UTC or America/Montreal"
                  value={defaultsDraft.defaultTimeZone}
                  onChange={(event) =>
                    setDefaultsDraft((current) => ({
                      ...current,
                      defaultTimeZone: event.target.value
                    }))
                  }
                />
              </div>

              <ToggleCard
                checked={defaultsDraft.enableOnCreate}
                onChange={(next) =>
                  setDefaultsDraft((current) => ({ ...current, enableOnCreate: next }))
                }
                label="Enable new jobs by default"
                hint="Useful when you want new scheduled jobs to start computing immediately."
              />

              <div>
                <Button type="submit" disabled={busyKey === "scheduled-job-defaults"}>
                  {busyKey === "scheduled-job-defaults" ? "Saving..." : "Save defaults"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>Composer</p>
                <h2 className="text-lg font-semibold text-on-surface">
                  {editingJobId ? "Edit recurring job" : "Create recurring job"}
                </h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Use a standard five-field cron string. The prompt becomes the reusable work
                  instruction for future execution.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={PILL_GRAY}>cron powered</span>
                <span className={PILL_GRAY}>user owned</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void handleJobSubmit(event)}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="job-name">Job name</Label>
                  <Input
                    id="job-name"
                    placeholder="Morning digest"
                    value={jobDraft.jobName}
                    onChange={(event) =>
                      setJobDraft((current) => ({ ...current, jobName: event.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="job-tz">Time zone</Label>
                  <Input
                    id="job-tz"
                    placeholder="UTC"
                    value={jobDraft.timeZone}
                    onChange={(event) =>
                      setJobDraft((current) => ({ ...current, timeZone: event.target.value }))
                    }
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="job-description">Description</Label>
                <Input
                  id="job-description"
                  placeholder="Optional context for what this recurring job is meant to do"
                  value={jobDraft.description}
                  onChange={(event) =>
                    setJobDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="job-cron">Cron expression</Label>
                <Input
                  id="job-cron"
                  placeholder="0 9 * * 1-5"
                  value={jobDraft.cronExpression}
                  onChange={(event) =>
                    setJobDraft((current) => ({ ...current, cronExpression: event.target.value }))
                  }
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="job-prompt">Prompt</Label>
                <Textarea
                  id="job-prompt"
                  rows={6}
                  value={jobDraft.prompt}
                  onChange={(event) =>
                    setJobDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
              </div>

              <ToggleCard
                checked={jobDraft.enabled}
                onChange={(next) => setJobDraft((current) => ({ ...current, enabled: next }))}
                label="Enabled"
                hint="Disabled jobs stay saved but stop computing the next scheduled run."
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={busyKey === "scheduled-job"}>
                  {busyKey === "scheduled-job"
                    ? "Saving..."
                    : editingJobId
                      ? "Update job"
                      : "Create job"}
                </Button>
                {editingJobId ? (
                  <Button type="button" variant="ghost" onClick={handleCancelEdit}>
                    Cancel edit
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>Queue</p>
                <h2 className="text-lg font-semibold text-on-surface">Saved jobs</h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Recurring workflows saved to this tenant. Expand a job to inspect its most recent
                  runs.
                </p>
              </div>
              <span className={PILL_GRAY}>{scheduledJobs.length} total</span>
            </div>
          </CardHeader>
          <CardContent>
            {scheduledJobs.length === 0 ? (
              <div className={`${LIST_ITEM} flex flex-col gap-1`}>
                <strong className="text-sm font-semibold text-on-surface">
                  No scheduled jobs yet
                </strong>
                <p className={HINT}>
                  Save your defaults, then create the first recurring workflow.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {scheduledJobs.map((job) => (
                  <div
                    className={`${LIST_ITEM} flex flex-col gap-3 sm:flex-row sm:justify-between`}
                    key={job.jobId}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-sm font-semibold text-on-surface">
                          {job.jobName}
                        </strong>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={PILL_GRAY}>{job.scheduleKind}</span>
                          <span className={job.enabled ? PILL_GREEN : PILL_GRAY}>
                            {job.enabled ? "enabled" : "disabled"}
                          </span>
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-on-surface-variant">
                        {job.description || "No description"}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={CHIP}>{job.cronExpression}</span>
                        <span className={CHIP}>tz {job.timeZone}</span>
                        <span className={CHIP}>next {formatMediumDateTime(job.nextRunAt, "Not scheduled yet")}</span>
                      </div>

                      {expandedRunsJobId === job.jobId ? (
                        <div className="mt-3 flex flex-col gap-2">
                          {jobRuns.length === 0 ? (
                            <p className={HINT}>No runs recorded yet</p>
                          ) : (
                            jobRuns.map((run) => (
                              <div
                                key={run.runId}
                                className="rounded border border-outline-variant bg-surface-container-low p-2"
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className={runStatusPillClass(run.status)}>
                                    {run.status}
                                  </span>
                                  <span className={CHIP}>{formatMediumDateTime(run.startedAt, "Not scheduled yet")}</span>
                                  {run.durationMs != null ? (
                                    <span className={CHIP}>
                                      {(run.durationMs / 1000).toFixed(1)}s
                                    </span>
                                  ) : null}
                                </div>
                                {run.status === "failed" && run.errorMessage ? (
                                  <p className="mt-1 text-xs text-danger">{run.errorMessage}</p>
                                ) : null}
                                {run.summary ? (
                                  <p className="mt-1 text-xs text-on-surface-variant">
                                    {run.summary}
                                  </p>
                                ) : null}
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditJob(job)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busyKey === `runs-${job.jobId}`}
                        onClick={() => handleToggleRuns(job.jobId)}
                      >
                        {busyKey === `runs-${job.jobId}` ? "Loading..." : "Runs"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busyKey === `toggle-${job.jobId}`}
                        onClick={() => handleToggleJob(job)}
                      >
                        {job.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busyKey === `delete-${job.jobId}`}
                        onClick={() => handleDeleteJob(job.jobId)}
                      >
                        {busyKey === `delete-${job.jobId}` ? "Deleting..." : "Delete"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
