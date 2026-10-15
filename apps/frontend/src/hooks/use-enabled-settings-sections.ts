"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  listSettingsLiveSections,
  listSettingsNavigationItems,
  type SettingsLiveSection
} from "../app/settings/settings-sections";
import { fetchIntegrationsAvailability } from "../lib/integrations-api";
import { queryKeys } from "../lib/query-keys";
import { fetchJiraConnectionStatus } from "../lib/settings-api";
import { hasJiraAccountsToManage } from "./use-jira-connection";
import { toErrorMessage } from "../lib/error-utils";
import type { NavigationItem } from "@cogniplane/shared-types";

export function useEnabledSettingsSections(): {
  liveSections: SettingsLiveSection[];
  navigationItems: NavigationItem[];
  isLoading: boolean;
  error: string | null;
  retry: () => void;
} {
  const availabilityQuery = useQuery({
    queryKey: queryKeys.settings.integrationsAvailability(),
    queryFn: fetchIntegrationsAvailability
  });

  // A disabled integration leaves the availability list. Jira stays reachable
  // while the member still has accounts to remove in Pipedream, because its
  // page is the only place to disconnect them. Jira also stays while the last
  // status lookup failed, including during its retry: a failure does not prove
  // that there is nothing to remove.
  // Only this check owns the Jira status here. When Jira is available, or
  // availability is unknown, the shared query belongs to the Jira row, so a
  // cached status error must not show as a settings error.
  const jiraAvailable = availabilityQuery.data?.some((view) => view.id === "jira") ?? false;
  const checkJiraStatus = availabilityQuery.isSuccess && !jiraAvailable;
  const jiraStatusQuery = useQuery({
    queryKey: queryKeys.settings.jira(),
    queryFn: fetchJiraConnectionStatus,
    enabled: checkJiraStatus
  });
  const jiraStatusFailed = checkJiraStatus && jiraStatusQuery.errorUpdatedAt > jiraStatusQuery.dataUpdatedAt;
  const keepJira = checkJiraStatus && (jiraStatusFailed || hasJiraAccountsToManage(jiraStatusQuery.data));

  const enabledIds = useMemo(() => {
    const set = new Set<string>();
    for (const view of availabilityQuery.data ?? []) {
      set.add(view.id);
    }
    if (keepJira) set.add("jira");
    return set;
  }, [availabilityQuery.data, keepJira]);

  // While loading, hide integration entries to avoid flash-then-disappear.
  const isLoading = availabilityQuery.isLoading || (checkJiraStatus && jiraStatusQuery.isLoading && !jiraStatusFailed);

  const liveSections = useMemo<SettingsLiveSection[]>(() => {
    return listSettingsLiveSections().filter((section) => {
      if (section.kind === "always") return true;
      if (isLoading) return false;
      return enabledIds.has(section.id);
    });
  }, [enabledIds, isLoading]);

  const navigationItems = useMemo(() => {
    const integrationIds = new Set(
      listSettingsLiveSections()
        .filter((s) => s.kind === "integration")
        .map((s) => s.id)
    );
    return listSettingsNavigationItems().filter((item) => {
      if (!integrationIds.has(item.id)) return true;
      if (isLoading) return false;
      return enabledIds.has(item.id);
    });
  }, [enabledIds, isLoading]);

  return {
    liveSections,
    navigationItems,
    isLoading,
    error: availabilityQuery.error
      ? toErrorMessage(availabilityQuery.error, "Could not load available services.")
      : checkJiraStatus && jiraStatusQuery.isError
        ? "Could not check your Jira connection."
        : null,
    retry: () => {
      if (availabilityQuery.isError) void availabilityQuery.refetch();
      if (checkJiraStatus && jiraStatusQuery.isError) void jiraStatusQuery.refetch();
    }
  };
}
