import { queryKeys } from "../../../../apps/frontend/src/lib/query-keys";

// React Query keys of this overlay. The values did not change when they moved
// out of core. The settings key stays under the core settings prefix, so an
// invalidation of all settings queries also refreshes it.
export const microsoftQueryKeys = {
  settings: () => [...queryKeys.settings.all, "microsoft"] as const,
  all: ["microsoft"] as const,
  connectionStatus: () => [...microsoftQueryKeys.all, "connection-status"] as const,
  sites: (search: string) => [...microsoftQueryKeys.all, "sites", search] as const,
  browse: (location: { siteId: string | null; driveId: string | null; folderId: string | null }) =>
    [...microsoftQueryKeys.all, "browse", location] as const,
  search: (query: string) => [...microsoftQueryKeys.all, "search", query] as const
};
