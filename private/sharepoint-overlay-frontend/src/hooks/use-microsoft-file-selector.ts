"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { MicrosoftFile, MicrosoftSite } from "../../../sharepoint-overlay-contracts/src/index";
import {
  getMicrosoftConnectionStatus,
  importMicrosoftFileToSession,
  listMicrosoftFiles,
  listMicrosoftSites,
  searchMicrosoftFiles
} from "../lib/microsoft-file-api";
import { microsoftQueryKeys } from "../lib/query-keys";

type BrowseLocation = {
  label: string;
  siteId: string | null;
  driveId: string | null;
  folderId: string | null;
};

const ONEDRIVE_ROOT: BrowseLocation = {
  label: "OneDrive",
  siteId: null,
  driveId: null,
  folderId: null
};

export function useMicrosoftFileSelector(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
  onRefreshArtifacts: () => Promise<void>;
  onImportedArtifact: (artifactId: string) => void;
}) {
  const { selectedSessionId, onError, onRefreshArtifacts, onImportedArtifact } = input;

  const [siteSearch, setSiteSearch] = useState("");
  const [activeSiteSearch, setActiveSiteSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [browseStack, setBrowseStack] = useState<BrowseLocation[]>([ONEDRIVE_ROOT]);

  const currentLocation = useMemo(
    () => browseStack[browseStack.length - 1] ?? ONEDRIVE_ROOT,
    [browseStack]
  );

  useEffect(() => {
    // Resetting local navigation/search state when the session changes so the
    // picker reopens in a clean state (the chat context has changed).
    setBrowseStack([ONEDRIVE_ROOT]);
    setSearchQuery("");
    setActiveSearchQuery("");
    setSiteSearch("");
    setActiveSiteSearch("");
  }, [selectedSessionId]);

  const connectionStatusQuery = useQuery({
    queryKey: microsoftQueryKeys.connectionStatus(),
    queryFn: getMicrosoftConnectionStatus
  });

  const hasUserConnection = Boolean(connectionStatusQuery.data?.userConnection);

  const sitesQuery = useQuery({
    queryKey: microsoftQueryKeys.sites(activeSiteSearch),
    queryFn: () => listMicrosoftSites(activeSiteSearch || undefined),
    enabled: hasUserConnection
  });

  const browseQuery = useQuery({
    queryKey: microsoftQueryKeys.browse({
      siteId: currentLocation.siteId,
      driveId: currentLocation.driveId,
      folderId: currentLocation.folderId
    }),
    queryFn: () =>
      listMicrosoftFiles({
        siteId: currentLocation.siteId,
        driveId: currentLocation.driveId,
        folderId: currentLocation.folderId
      }),
    enabled: hasUserConnection
  });

  const searchResultsQuery = useQuery({
    queryKey: microsoftQueryKeys.search(activeSearchQuery),
    queryFn: () => searchMicrosoftFiles(activeSearchQuery),
    enabled: hasUserConnection && activeSearchQuery.length > 0
  });

  const importMutation = useMutation({
    mutationFn: async (file: MicrosoftFile) => {
      if (!selectedSessionId) {
        throw new Error("No session selected.");
      }
      const artifact = await importMicrosoftFileToSession({
        sessionId: selectedSessionId,
        driveId: file.driveId,
        itemId: file.itemId,
        artifactName: file.name
      });
      await onRefreshArtifacts();
      return artifact;
    },
    onSuccess: (artifact) => onImportedArtifact(artifact.artifactId),
    onError: (error) => onError(error instanceof Error ? error.message : String(error))
  });

  // Surface query errors through the shared onError callback to match the
  // original fire-and-forget behavior consumers expect.
  useEffect(() => {
    if (connectionStatusQuery.error) {
      onError(
        connectionStatusQuery.error instanceof Error
          ? connectionStatusQuery.error.message
          : String(connectionStatusQuery.error)
      );
    }
  }, [connectionStatusQuery.error, onError]);
  useEffect(() => {
    if (sitesQuery.error) {
      onError(
        sitesQuery.error instanceof Error ? sitesQuery.error.message : String(sitesQuery.error)
      );
    }
  }, [sitesQuery.error, onError]);
  useEffect(() => {
    if (browseQuery.error) {
      onError(
        browseQuery.error instanceof Error ? browseQuery.error.message : String(browseQuery.error)
      );
    }
  }, [browseQuery.error, onError]);
  useEffect(() => {
    if (searchResultsQuery.error) {
      onError(
        searchResultsQuery.error instanceof Error
          ? searchResultsQuery.error.message
          : String(searchResultsQuery.error)
      );
    }
  }, [searchResultsQuery.error, onError]);

  const runSearch = useCallback(() => {
    const query = searchQuery.trim();
    setActiveSearchQuery(query);
  }, [searchQuery]);

  const refreshSites = useCallback(() => {
    setActiveSiteSearch(siteSearch.trim());
  }, [siteSearch]);

  const openOneDriveRoot = useCallback(() => {
    setBrowseStack([ONEDRIVE_ROOT]);
  }, []);

  const openSite = useCallback((site: MicrosoftSite) => {
    setBrowseStack([
      {
        label: site.displayName ?? site.name ?? "SharePoint site",
        siteId: site.siteId,
        driveId: null,
        folderId: null
      }
    ]);
  }, []);

  const openFolder = useCallback(
    (file: MicrosoftFile) => {
      if (!file.isFolder) return;
      setBrowseStack((current) => [
        ...current,
        {
          label: file.name,
          siteId: file.siteId ?? currentLocation.siteId,
          driveId: file.driveId,
          folderId: file.itemId
        }
      ]);
    },
    [currentLocation.siteId]
  );

  const navigateToBreadcrumb = useCallback((index: number) => {
    setBrowseStack((current) =>
      index >= 0 && index < current.length ? current.slice(0, index + 1) : current
    );
  }, []);

  const importFile = useCallback(
    async (file: MicrosoftFile) => {
      if (!selectedSessionId || !file.isFile) return;
      await importMutation.mutateAsync(file).catch(() => undefined);
    },
    [importMutation, selectedSessionId]
  );

  return {
    connectionStatus: connectionStatusQuery.data ?? null,
    sites: sitesQuery.data ?? [],
    siteSearch,
    setSiteSearch,
    isLoadingSites: sitesQuery.isFetching,
    refreshSites,
    searchQuery,
    setSearchQuery,
    searchResults: searchResultsQuery.data ?? [],
    isSearching: searchResultsQuery.isFetching,
    runSearch,
    currentLocation,
    browseStack,
    browseItems: browseQuery.data ?? [],
    isLoadingBrowse: browseQuery.isFetching,
    openOneDriveRoot,
    openSite,
    openFolder,
    navigateToBreadcrumb,
    importFile,
    importingItemId: importMutation.isPending ? importMutation.variables?.itemId ?? null : null
  };
}
