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
import type { NavigationItem } from "@cogniplane/shared-types";

export function useEnabledSettingsSections(): {
  liveSections: SettingsLiveSection[];
  navigationItems: NavigationItem[];
  isLoading: boolean;
} {
  const availabilityQuery = useQuery({
    queryKey: queryKeys.settings.integrationsAvailability(),
    queryFn: fetchIntegrationsAvailability
  });

  const enabledIds = useMemo(() => {
    const set = new Set<string>();
    for (const view of availabilityQuery.data ?? []) {
      set.add(view.id);
    }
    return set;
  }, [availabilityQuery.data]);

  // While loading, hide integration entries to avoid flash-then-disappear.
  const isLoading = availabilityQuery.isLoading;

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

  return { liveSections, navigationItems, isLoading };
}
