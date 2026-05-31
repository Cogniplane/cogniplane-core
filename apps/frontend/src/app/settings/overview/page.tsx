"use client";

import { useSettingsOverviewData } from "../../../hooks/use-settings-overview-data";
import { SettingsOverviewSection } from "../../../components/settings-overview-section";
import { listSettingsLiveSections } from "../settings-sections";

export default function SettingsOverviewPage() {
  const { scheduledJobsCount, enabledJobsCount, error } = useSettingsOverviewData();

  const overviewStats = [
    {
      label: "Live settings",
      value: String(listSettingsLiveSections().length),
      detail: "Sections available in your settings"
    },
    {
      label: "Recurring jobs",
      value: String(scheduledJobsCount),
      detail: "Personal jobs stored under your account"
    },
    {
      label: "Enabled jobs",
      value: String(enabledJobsCount),
      detail: "Jobs that currently compute a next run"
    }
  ];

  return <SettingsOverviewSection error={error} overviewStats={overviewStats} />;
}
