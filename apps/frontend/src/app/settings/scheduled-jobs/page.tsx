"use client";

import { useScheduledJobsData } from "../../../hooks/use-scheduled-jobs-data";
import { ScheduledJobsSection } from "../../../components/scheduled-jobs-section";

export default function SettingsScheduledJobsPage() {
  const {
    scheduledJobs,
    defaultsDraft,
    setDefaultsDraft,
    jobDraft,
    setJobDraft,
    editingJobId,
    expandedRunsJobId,
    jobRuns,
    busyKey,
    error: jobsError,
    handleDefaultsSubmit,
    handleJobSubmit,
    handleEditJob,
    handleCancelEdit,
    handleDeleteJob,
    handleToggleJob,
    handleToggleRuns
  } = useScheduledJobsData();

  return (
    <>
      {jobsError ? <p className="text-sm text-danger">{jobsError}</p> : null}
      <ScheduledJobsSection
        busyKey={busyKey}
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
    </>
  );
}
