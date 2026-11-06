"use client";

import { useScheduledJobsData } from "../../../hooks/use-scheduled-jobs-data";
import { ScheduledJobsSection } from "../../../components/scheduled-jobs-section";

export default function SettingsScheduledJobsPage() {
  return <ScheduledJobsSection {...useScheduledJobsData()} />;
}
