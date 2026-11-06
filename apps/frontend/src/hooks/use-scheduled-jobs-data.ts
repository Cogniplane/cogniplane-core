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
import { inferScheduleMode } from "../lib/scheduled-job-schedule";
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
        : { defaultTimeZone: "UTC", enableOnCreate: false },
    [sectionsQuery.data]
  );

  const [defaultsDraft, setDefaultsDraft] = useState<ScheduledJobDefaults>(defaultsFromSections);
  const [jobDraft, setJobDraft] = useState<JobDraft>(defaultJobDraft(defaultsFromSections));
  const [originalJobDraft, setOriginalJobDraft] = useState<JobDraft | null>(null);
  const mutationLock = useRef(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const editingJobIdRef = useRef<string | null>(null);
  const [expandedRunsJobId, setExpandedRunsJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ scope: "defaults" | "job" | "list"; message: string; jobId?: string } | null>(null);

  useEffect(() => {
    editingJobIdRef.current = editingJobId;
  }, [editingJobId]);

  // Apply loaded defaults only to drafts that the user has not changed.
  const defaultsSignature = JSON.stringify(defaultsFromSections);
  const [appliedDefaultsSignature, setAppliedDefaultsSignature] = useState<string | null>(null);
  const defaultsLoaded = sectionsQuery.data !== undefined && appliedDefaultsSignature === defaultsSignature;
  const previousDefaultsRef = useRef<ScheduledJobDefaults>({ defaultTimeZone: "UTC", enableOnCreate: false });
  useEffect(() => {
    if (!sectionsQuery.data) return;
    if (defaultsSignature === appliedDefaultsSignature) return;
    const previous = previousDefaultsRef.current;
    previousDefaultsRef.current = defaultsFromSections;
    setDefaultsDraft(current => JSON.stringify(current) === JSON.stringify(previous) ? defaultsFromSections : current);
    if (!editingJobIdRef.current && originalJobDraft === null) {
      setJobDraft(current => JSON.stringify(current) === JSON.stringify(defaultJobDraft(previous))
        ? defaultJobDraft(defaultsFromSections) : current);
    }
    setAppliedDefaultsSignature(defaultsSignature);
  }, [sectionsQuery.data, defaultsFromSections, defaultsSignature, appliedDefaultsSignature, originalJobDraft]);

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
        return updateScheduledJob(input.editingId, payload);
      } else {
        return createScheduledJob(payload);
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<ScheduledJob[]>(queryKeys.settings.scheduledJobs(), current =>
        current?.some(job => job.jobId === saved.jobId) ? current.map(job => job.jobId === saved.jobId ? saved : job) : [...(current ?? []), saved]);
      return invalidateJobs();
    }
  });

  const deleteJobMutation = useMutation({
    mutationFn: deleteScheduledJob,
    onSuccess: (_result, jobId) => {
      queryClient.setQueryData<ScheduledJob[]>(queryKeys.settings.scheduledJobs(), current => current?.filter(job => job.jobId !== jobId));
      return invalidateJobs();
    }
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
      if (mutationLock.current || !defaultsLoaded) return;
      mutationLock.current = true;
      setActionError(null);
      try {
        await saveDefaultsMutation.mutateAsync(defaultsDraft);
      } catch (error) {
        setActionError({ scope: "defaults", message: toErrorMessage(error, "Failed to save defaults.") });
      } finally { mutationLock.current = false; }
    },
    [defaultsDraft, saveDefaultsMutation, defaultsLoaded]
  );

  const handleJobSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>, enabled?: boolean) => {
      event.preventDefault();
      if (mutationLock.current) return false;
      mutationLock.current = true;
      setActionError(null);
      try {
        await submitJobMutation.mutateAsync({
          editingId: editingJobId,
          draft: { ...jobDraft, enabled: editingJobId ? jobDraft.enabled : enabled === true }
        });
        setEditingJobId(null);
        setOriginalJobDraft(null);
        setJobDraft(defaultJobDraft(defaultsDraft));
        return true;
      } catch (error) {
        setActionError({ scope: "job", message: toErrorMessage(error, "Failed to save scheduled job.") });
        return false;
      } finally { mutationLock.current = false; }
    },
    [defaultsDraft, editingJobId, jobDraft, submitJobMutation]
  );

  const handleCancelEdit = useCallback(() => {
    setActionError(null);
    setEditingJobId(null);
    setOriginalJobDraft(null);
    setJobDraft(defaultJobDraft(defaultsDraft));
  }, [defaultsDraft]);

  const handleNewJob = useCallback(() => {
    if (!defaultsLoaded || mutationLock.current) return;
    const draft = defaultJobDraft(defaultsDraft);
    setActionError(null);
    setEditingJobId(null);
    setJobDraft(draft);
    setOriginalJobDraft(draft);
  }, [defaultsDraft, defaultsLoaded]);

  // Only an explicit save can resume a job paused after a security change.
  const handleEditJob = useCallback((job: ScheduledJob, options?: { enable?: boolean }) => {
    if (mutationLock.current) return;
    setActionError(null);
    setEditingJobId(job.jobId);
    const draft: JobDraft = {
      jobName: job.jobName,
      description: job.description ?? "",
      cronExpression: job.cronExpression,
      scheduleMode: inferScheduleMode(job.cronExpression),
      timeZone: job.timeZone,
      prompt: job.input.prompt,
      enabled: options?.enable ?? job.enabled
    };
    setJobDraft(draft);
    setOriginalJobDraft(draft);
  }, []);

  const handleDeleteJob = useCallback(
    async (jobId: string) => {
      if (mutationLock.current) return false;
      mutationLock.current = true;
      setActionError(null);
      try {
        await deleteJobMutation.mutateAsync(jobId);
        if (editingJobId === jobId) handleCancelEdit();
        if (expandedRunsJobId === jobId) setExpandedRunsJobId(null);
        return true;
      } catch (error) {
        setActionError({ scope: "list", jobId, message: toErrorMessage(error, "Failed to delete scheduled job.") });
        return false;
      } finally { mutationLock.current = false; }
    },
    [deleteJobMutation, editingJobId, expandedRunsJobId, handleCancelEdit]
  );

  const handleToggleJob = useCallback(
    (job: ScheduledJob) => {
      if (mutationLock.current || job.pausedReason === "security_change") return;
      mutationLock.current = true;
      setActionError(null);
      toggleJobMutation.mutate(job, {
        onSettled: () => { mutationLock.current = false; },
        onError: (error) =>
          setActionError({ scope: "list", jobId: job.jobId, message: toErrorMessage(error, "Failed to update scheduled job.") })
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

  const runsError = runsQuery.error
    ? toErrorMessage(runsQuery.error, "Failed to load job runs.")
    : null;

  return {
    scheduledJobs,
    jobDirty: originalJobDraft !== null && JSON.stringify(jobDraft) !== JSON.stringify(originalJobDraft),
    defaultsLoaded,
    defaultsLoading: sectionsQuery.isFetching,
    jobsLoaded: jobsQuery.data !== undefined,
    runsLoaded: runsQuery.data !== undefined,
    jobsRefreshing: jobsQuery.isFetching && jobsQuery.data !== undefined,
    runsRefreshing: runsQuery.isFetching && runsQuery.data !== undefined,
    jobsLoading: jobsQuery.isPending,
    jobsLoadFailed: jobsQuery.isError,
    retryJobs: () => jobsQuery.refetch(),
    defaultsDirty: JSON.stringify(defaultsDraft) !== JSON.stringify(defaultsFromSections),
    resetDefaults: () => { setDefaultsDraft(defaultsFromSections); setActionError(null); },
    defaultsError: actionError?.scope === "defaults" ? actionError.message : sectionsQuery.error
      ? toErrorMessage(sectionsQuery.error, "Failed to load job defaults.") : null,
    defaultsLoadFailed: sectionsQuery.isError,
    retryDefaults: () => sectionsQuery.refetch(),
    jobError: actionError?.scope === "job" ? actionError.message : null,
    listActionError: actionError?.scope === "list" ? actionError : null,
    defaultsDraft,
    setDefaultsDraft,
    jobDraft,
    setJobDraft,
    editingJobId,
    expandedRunsJobId,
    jobRuns: runsQuery.data ?? [],
    runsLoading: runsQuery.isPending && expandedRunsJobId !== null,
    runsError,
    retryRuns: () => runsQuery.refetch(),
    busyKey,
    handleDefaultsSubmit,
    handleNewJob,
    handleJobSubmit,
    handleEditJob,
    handleCancelEdit,
    handleDeleteJob,
    handleToggleJob,
    handleToggleRuns
  };
}
