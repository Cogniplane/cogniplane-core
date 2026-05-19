"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { FileSourceDefinition } from "../components/file-source-picker";
import { fetchIntegrationsAvailability } from "../lib/integrations-api";
import { queryKeys } from "../lib/query-keys";

// File-source registration. Each registered entry contributes one tile to
// the file-source picker UI. Private overlays (e.g. SharePoint) register
// their own file-source factory at module load. The OSS subset has no
// registered factories and the picker simply shows nothing.
//
// Rules-of-hooks compliance: each factory's `useEntry` is invoked in the
// same order on every render (registration happens once at module load,
// before any render).

export type FileSourceFactoryInput = {
  selectedSessionId: string | null;
  onError: (message: string) => void;
  onRefreshArtifacts: () => Promise<void>;
  onImportedArtifact: (artifactId: string) => void;
};

export type FileSourceFactory = {
  /**
   * Integration id the source is gated by — pulled from the
   * `/me/integrations-availability` response. When the id is not in the
   * tenant's enabled set the factory's `useEntry` is still called (to keep
   * hook order stable) but its result is discarded.
   */
  integrationId: string;
  /**
   * Hook that returns the rendered file-source definition. Called once
   * per render of `useFileSources` regardless of whether the integration
   * is enabled — implementations should short-circuit network calls
   * internally (see use-microsoft-file-selector for the pattern).
   */
  useEntry: (input: FileSourceFactoryInput) => FileSourceDefinition;
};

const factories: FileSourceFactory[] = [];

export function registerFileSource(factory: FileSourceFactory): void {
  if (factories.some((f) => f.integrationId === factory.integrationId)) return;
  factories.push(factory);
}

export function useFileSources(input: FileSourceFactoryInput) {
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

  // Call every registered factory unconditionally to keep hook order
  // stable. Filter the results afterwards based on integration enablement.
  const entries = factories.map((factory) => ({
    factory,
    entry: factory.useEntry(input)
  }));

  // Collapse the entry list into a single change key — eslint's
  // react-hooks/use-memo rule requires a literal deps array, and each
  // entry's id+connection-kind captures the meaningful shape changes that
  // should trigger a re-filter.
  const entriesKey = entries
    .map(({ entry }) => `${entry.id}:${entry.connection.kind}`)
    .join("|");
  const sources = useMemo<FileSourceDefinition[]>(
    () =>
      entries
        .filter(({ factory }) => enabledIds.has(factory.integrationId))
        .map(({ entry }) => entry),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabledIds, entriesKey]
  );

  return {
    sources,
    isLoading: availabilityQuery.isLoading
  };
}
