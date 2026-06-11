"use client";

import { useQuery } from "@tanstack/react-query";

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

// Must run every render, never memoized: each factory's `useEntry` returns
// fresh closures (search state, selected session) that go stale if cached.
export function selectEnabledFileSources(
  entries: ReadonlyArray<{ factory: FileSourceFactory; entry: FileSourceDefinition }>,
  enabledIntegrationIds: ReadonlyArray<string>
): FileSourceDefinition[] {
  const enabledIds = new Set(enabledIntegrationIds);
  return entries
    .filter(({ factory }) => enabledIds.has(factory.integrationId))
    .map(({ entry }) => entry);
}

export function useFileSources(input: FileSourceFactoryInput) {
  const availabilityQuery = useQuery({
    queryKey: queryKeys.settings.integrationsAvailability(),
    queryFn: fetchIntegrationsAvailability
  });

  // Call every registered factory unconditionally to keep hook order
  // stable. Filter the results afterwards based on integration enablement.
  const entries = factories.map((factory) => ({
    factory,
    entry: factory.useEntry(input)
  }));

  const sources = selectEnabledFileSources(
    entries,
    (availabilityQuery.data ?? []).map((view) => view.id)
  );

  return {
    sources,
    isLoading: availabilityQuery.isLoading
  };
}
