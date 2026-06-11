"use client";

import { useAdminOverviewData } from "../../../hooks/use-admin-overview-data";
import { AdminOverviewSection } from "../../../components/admin/admin-overview-section";
import { ADMIN_LIVE_SECTIONS } from "../admin-sections";

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
      value: String(ADMIN_LIVE_SECTIONS.length),
      detail: "Admin sections available in the control plane"
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
    }
  ];

  return <AdminOverviewSection error={error} overviewStats={overviewStats} />;
}
