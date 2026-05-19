"use client";

import { useQuery } from "@tanstack/react-query";

import { listScheduledJobs } from "../lib/settings-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

type SettingsOverviewData = {
  scheduledJobsCount: number;
  enabledJobsCount: number;
  error: string | null;
};

export function useSettingsOverviewData(): SettingsOverviewData {
  const jobs = useQuery({
    queryKey: queryKeys.settings.scheduledJobs(),
    queryFn: listScheduledJobs
  });

  return {
    scheduledJobsCount: jobs.data?.length ?? 0,
    enabledJobsCount: jobs.data?.filter((job) => job.enabled).length ?? 0,
    error: jobs.error ? toErrorMessage(jobs.error, "Failed to load settings overview.") : null
  };
}
