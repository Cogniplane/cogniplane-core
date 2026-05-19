"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  createScheduledJob,
  deleteScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  listUserSettingsSections,
  updateScheduledJob,
  updateUserSettingsSection
} from "../lib/settings-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { ScheduledJob } from "@cogniplane/shared-types";
import {
  defaultJobDraft,
  readScheduledJobDefaults,
  type JobDraft,
  type ScheduledJobDefaults
} from "../lib/settings-console-types";

export function useScheduledJobsData() {
  const queryClient = useQueryClient();

  const jobsQuery = useQuery({
    queryKey: queryKeys.settings.scheduledJobs(),
    queryFn: listScheduledJobs
  });
  const sectionsQuery = useQuery({
    queryKey: queryKeys.settings.sections(),
    queryFn: listUserSettingsSections
  });

  const invalidateJobs = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.scheduledJobs() });
  const invalidateSections = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.sections() });

  const scheduledJobs = jobsQuery.data ?? [];

  const defaultsFromSections = useMemo<ScheduledJobDefaults>(
    () =>
      sectionsQuery.data
        ? readScheduledJobDefaults(
            sectionsQuery.data.find((section) => section.sectionKey === "scheduled_jobs")
          )
        : { defaultTimeZone: "UTC", enableOnCreate: true },
    [sectionsQuery.data]
  );

  const [defaultsDraft, setDefaultsDraft] = useState<ScheduledJobDefaults>(defaultsFromSections);
  const [jobDraft, setJobDraft] = useState<JobDraft>(defaultJobDraft(defaultsFromSections));
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const editingJobIdRef = useRef<string | null>(null);
  const [expandedRunsJobId, setExpandedRunsJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    editingJobIdRef.current = editingJobId;
  }, [editingJobId]);

  // Sync local defaults + draft when the remote sections load / refresh,
  // but never clobber an active edit session.
  const appliedDefaultsSignatureRef = useRef<string>("");
  useEffect(() => {
    if (!sectionsQuery.data) return;
    const signature = JSON.stringify(defaultsFromSections);
    if (signature === appliedDefaultsSignatureRef.current) return;
    appliedDefaultsSignatureRef.current = signature;
    setDefaultsDraft(defaultsFromSections);
    if (!editingJobIdRef.current) {
      setJobDraft(defaultJobDraft(defaultsFromSections));
    }
  }, [sectionsQuery.data, defaultsFromSections]);

  const runsQuery = useQuery({
    queryKey: expandedRunsJobId
      ? queryKeys.settings.scheduledJobRuns(expandedRunsJobId)
      : ["settings", "scheduled-jobs", "__no-expanded__"],
    queryFn: async () =>
      expandedRunsJobId ? listScheduledJobRuns(expandedRunsJobId) : [],
    enabled: expandedRunsJobId !== null
  });

  const saveDefaultsMutation = useMutation({
    mutationFn: (draft: ScheduledJobDefaults) =>
      updateUserSettingsSection("scheduled_jobs", {
        defaultTimeZone: draft.defaultTimeZone,
        enableOnCreate: draft.enableOnCreate
      }),
    onSuccess: () => invalidateSections()
  });

  const submitJobMutation = useMutation({
    mutationFn: async (input: { editingId: string | null; draft: JobDraft }) => {
      const payload = {
        jobName: input.draft.jobName,
        description: input.draft.description || null,
        cronExpression: input.draft.cronExpression,
        timeZone: input.draft.timeZone,
        targetType: "prompt" as const,
        input: { prompt: input.draft.prompt },
        enabled: input.draft.enabled
      };
      if (input.editingId) {
        await updateScheduledJob(input.editingId, payload);
      } else {
        await createScheduledJob(payload);
      }
    },
    onSuccess: () => invalidateJobs()
  });

  const deleteJobMutation = useMutation({
    mutationFn: deleteScheduledJob,
    onSuccess: () => invalidateJobs()
  });

  const toggleJobMutation = useMutation({
    mutationFn: (job: ScheduledJob) =>
      updateScheduledJob(job.jobId, {
        jobName: job.jobName,
        description: job.description,
        cronExpression: job.cronExpression,
        timeZone: job.timeZone,
        targetType: job.targetType,
        targetRef: job.targetRef,
        input: { prompt: job.input.prompt },
        enabled: !job.enabled
      }),
    onSuccess: () => invalidateJobs()
  });

  const handleDefaultsSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setActionError(null);
      try {
        await saveDefaultsMutation.mutateAsync(defaultsDraft);
      } catch (error) {
        setActionError(toErrorMessage(error, "Failed to save defaults."));
      }
    },
    [defaultsDraft, saveDefaultsMutation]
  );

  const handleJobSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setActionError(null);
      try {
        await submitJobMutation.mutateAsync({ editingId: editingJobId, draft: jobDraft });
        setEditingJobId(null);
        setJobDraft(defaultJobDraft(defaultsDraft));
      } catch (error) {
        setActionError(toErrorMessage(error, "Failed to save scheduled job."));
      }
    },
    [defaultsDraft, editingJobId, jobDraft, submitJobMutation]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingJobId(null);
    setJobDraft(defaultJobDraft(defaultsDraft));
  }, [defaultsDraft]);

  const handleEditJob = useCallback((job: ScheduledJob) => {
    setEditingJobId(job.jobId);
    setJobDraft({
      jobName: job.jobName,
      description: job.description ?? "",
      cronExpression: job.cronExpression,
      timeZone: job.timeZone,
      prompt: job.input.prompt,
      enabled: job.enabled
    });
  }, []);

  const handleDeleteJob = useCallback(
    (jobId: string) => {
      setActionError(null);
      deleteJobMutation.mutate(jobId, {
        onSuccess: () => {
          if (editingJobId === jobId) handleCancelEdit();
        },
        onError: (error) =>
          setActionError(toErrorMessage(error, "Failed to delete scheduled job."))
      });
    },
    [deleteJobMutation, editingJobId, handleCancelEdit]
  );

  const handleToggleJob = useCallback(
    (job: ScheduledJob) => {
      setActionError(null);
      toggleJobMutation.mutate(job, {
        onError: (error) =>
          setActionError(toErrorMessage(error, "Failed to update scheduled job."))
      });
    },
    [toggleJobMutation]
  );

  const handleToggleRuns = useCallback(
    (jobId: string) => {
      setActionError(null);
      setExpandedRunsJobId((current) => (current === jobId ? null : jobId));
    },
    []
  );

  let busyKey: string | null = null;
  if (saveDefaultsMutation.isPending) busyKey = "scheduled-job-defaults";
  else if (submitJobMutation.isPending) busyKey = "scheduled-job";
  else if (deleteJobMutation.isPending && deleteJobMutation.variables)
    busyKey = `delete-${deleteJobMutation.variables}`;
  else if (toggleJobMutation.isPending && toggleJobMutation.variables)
    busyKey = `toggle-${toggleJobMutation.variables.jobId}`;
  else if (runsQuery.isFetching && expandedRunsJobId) busyKey = `runs-${expandedRunsJobId}`;

  const loadError = jobsQuery.error ?? sectionsQuery.error;
  const runsError = runsQuery.error
    ? toErrorMessage(runsQuery.error, "Failed to load job runs.")
    : null;

  return {
    scheduledJobs,
    defaultsDraft,
    setDefaultsDraft,
    jobDraft,
    setJobDraft,
    editingJobId,
    expandedRunsJobId,
    jobRuns: runsQuery.data ?? [],
    busyKey,
    error:
      actionError ??
      runsError ??
      (loadError ? toErrorMessage(loadError, "Failed to load scheduled jobs.") : null),
    handleDefaultsSubmit,
    handleJobSubmit,
    handleEditJob,
    handleCancelEdit,
    handleDeleteJob,
    handleToggleJob,
    handleToggleRuns
  };
}
