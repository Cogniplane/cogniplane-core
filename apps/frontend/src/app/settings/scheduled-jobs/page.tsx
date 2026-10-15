"use client";

import { useScheduledJobsData } from "../../../hooks/use-scheduled-jobs-data";
import { ScheduledJobsSection } from "../../../components/scheduled-jobs-section";

export default function SettingsScheduledJobsPage() {
  const {
    scheduledJobs,
    jobsLoading,
    jobsLoadFailed,
    retryJobs,
    defaultsDirty,
    resetDefaults,
    defaultsError,
    defaultsLoadFailed,
    retryDefaults,
    jobError,
    listActionError,
    runsLoading,
    runsError,
    retryRuns,
    defaultsDraft,
    setDefaultsDraft,
    jobDraft,
    setJobDraft,
    editingJobId,
    expandedRunsJobId,
    jobRuns,
    busyKey,
    handleDefaultsSubmit,
    handleJobSubmit,
    handleEditJob,
    handleCancelEdit,
    handleDeleteJob,
    handleToggleJob,
    handleToggleRuns
  } = useScheduledJobsData();

  return (
    <ScheduledJobsSection
        busyKey={busyKey}
        jobsLoading={jobsLoading}
        jobsLoadFailed={jobsLoadFailed}
        retryJobs={retryJobs}
        defaultsDirty={defaultsDirty}
        resetDefaults={resetDefaults}
        defaultsError={defaultsError}
        defaultsLoadFailed={defaultsLoadFailed}
        retryDefaults={retryDefaults}
        jobError={jobError}
        listActionError={listActionError}
        runsLoading={runsLoading}
        runsError={runsError}
        retryRuns={retryRuns}
        defaultsDraft={defaultsDraft}
        editingJobId={editingJobId}
        expandedRunsJobId={expandedRunsJobId}
        handleCancelEdit={handleCancelEdit}
        handleDefaultsSubmit={handleDefaultsSubmit}
        handleDeleteJob={handleDeleteJob}
        handleEditJob={handleEditJob}
        handleJobSubmit={handleJobSubmit}
        handleToggleJob={handleToggleJob}
        handleToggleRuns={handleToggleRuns}
        jobDraft={jobDraft}
        jobRuns={jobRuns}
        scheduledJobs={scheduledJobs}
        setDefaultsDraft={setDefaultsDraft}
        setJobDraft={setJobDraft}
    />
  );
}
