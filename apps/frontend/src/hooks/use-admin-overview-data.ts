"use client";

import { useQuery } from "@tanstack/react-query";

import { listAdminMcpServers, listAdminSkills } from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

type AdminOverviewData = {
  skillsCount: number;
  enabledSkillsCount: number;
  mcpServersCount: number;
  error: string | null;
};

export function useAdminOverviewData(): AdminOverviewData {
  const skills = useQuery({
    queryKey: queryKeys.admin.skills(),
    queryFn: listAdminSkills
  });
  const mcpServers = useQuery({
    queryKey: queryKeys.admin.mcpServers(),
    queryFn: listAdminMcpServers
  });

  const firstError = skills.error ?? mcpServers.error;

  return {
    skillsCount: skills.data?.length ?? 0,
    enabledSkillsCount: skills.data?.filter((skill) => skill.enabled).length ?? 0,
    mcpServersCount: mcpServers.data?.length ?? 0,
    error: firstError ? toErrorMessage(firstError, "Failed to load overview data.") : null
  };
}
