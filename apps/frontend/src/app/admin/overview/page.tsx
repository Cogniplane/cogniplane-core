"use client";

import { useAdminOverviewData } from "../../../hooks/use-admin-overview-data";
import { AdminOverviewSection } from "../../../components/admin-overview-section";
import { AdminModuleRoadmap } from "../../../components/admin-module-roadmap";
import { ADMIN_PLANNED_SECTIONS } from "../admin-sections";

export default function AdminOverviewPage() {
  const {
    skillsCount,
    enabledSkillsCount,
    mcpServersCount,
    error
  } = useAdminOverviewData();

  const overviewStats = [
    {
      label: "Live modules",
      value: "6",
      detail: "Skills, MCP, agent settings, runtime rollout, users, and token usage"
    },
    {
      label: "Enabled skills",
      value: String(enabledSkillsCount),
      detail: `${skillsCount} registered in the control plane`
    },
    {
      label: "MCP servers",
      value: String(mcpServersCount),
      detail: "Registered in the gateway"
    },
    {
      label: "Planned modules",
      value: String(ADMIN_PLANNED_SECTIONS.length),
      detail: "Dashboard, tracing, and cost controls queued next"
    }
  ];

  return (
    <>
      <AdminOverviewSection error={error} overviewStats={overviewStats} />
      <AdminModuleRoadmap
        skillsCount={skillsCount}
        mcpServersCount={mcpServersCount}
        plannedModules={ADMIN_PLANNED_SECTIONS}
      />
    </>
  );
}
