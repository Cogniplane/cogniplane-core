"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  activateSkillRevision,
  disableAdminSkill,
  getSkillMarketplace,
  getTenantDetails,
  importAdminSkillGithub,
  importAdminSkillInline,
  importAdminSkillZip,
  listAdminSkills,
  listSkillRevisions,
  publishAdminSkill,
  unpublishAdminSkill,
  updateTenantMarketplaceManifestUrl
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type {
  SkillImportResponse,
  AdminSkillReleaseSnapshot,
  SkillMarketplaceEntry,
  SkillRevision,
  TenantDetails
} from "@cogniplane/shared-types";

export type SkillReadState = {
  status: "pending" | "failed" | "unavailable" | "empty" | "ready" | "stale";
  refreshing: boolean;
  error: string | null;
  retry: () => void;
};

function readState<T>(query: { data: T | undefined; isError: boolean; isPending: boolean; isFetching: boolean; fetchStatus: string; error: unknown; refetch: () => Promise<unknown> }, empty: (data: T) => boolean, fallback: string): SkillReadState {
  const hasData = query.data !== undefined;
  return {
    status: hasData ? query.isError ? "stale" : empty(query.data!) ? "empty" : "ready"
      : query.isError ? "failed" : query.fetchStatus === "paused" ? "unavailable" : "pending",
    refreshing: query.isFetching,
    error: query.isError ? toErrorMessage(query.error, fallback) : null,
    retry: () => { void query.refetch(); }
  };
}

export function useAdminSkillsData() {
  const queryClient = useQueryClient();

  const skillsQuery = useQuery({
    queryKey: queryKeys.admin.skills(),
    retry: false,
    queryFn: listAdminSkills
  });
  const marketplaceQuery = useQuery({
    queryKey: queryKeys.admin.marketplace(),
    retry: false,
    queryFn: getSkillMarketplace
  });
  const tenantQuery = useQuery({
    queryKey: queryKeys.admin.tenant(),
    retry: false,
    queryFn: getTenantDetails
  });

  const invalidateSkills = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.skills() });
  const invalidateMarketplace = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.marketplace() });
  const invalidateTenant = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenant() });

  const zipImportMutation = useMutation({
    mutationFn: importAdminSkillZip,
    onSuccess: invalidateSkills
  });

  const githubImportMutation = useMutation({
    mutationFn: importAdminSkillGithub,
    onSuccess: invalidateSkills
  });

  const inlineImportMutation = useMutation({
    mutationFn: importAdminSkillInline,
    onSuccess: invalidateSkills
  });

  const marketplaceImportMutation = useMutation({
    mutationFn: async (entry: SkillMarketplaceEntry) => {
      return importAdminSkillGithub({
        githubUrl: entry.repositoryUrl,
        ref: entry.ref,
        subdirectory: entry.subdirectory
      });
    },
    onSuccess: invalidateSkills
  });

  const activateMutation = useMutation({
    mutationFn: activateSkillRevision,
    // The revision transaction can commit before an audit write fails. Refresh
    // availability after either response so the list shows the actual state.
    onSettled: invalidateSkills
  });

  const publishMutation = useMutation({
    mutationFn: ({ skillId, snapshot }: { skillId: string; snapshot: AdminSkillReleaseSnapshot }) => publishAdminSkill(skillId, snapshot),
    onSettled: invalidateSkills
  });

  const unpublishMutation = useMutation({
    mutationFn: ({ skillId, snapshot }: { skillId: string; snapshot: AdminSkillReleaseSnapshot }) => unpublishAdminSkill(skillId, snapshot),
    onSettled: invalidateSkills
  });

  const disableMutation = useMutation({
    mutationFn: ({ skillId, snapshot }: { skillId: string; snapshot: AdminSkillReleaseSnapshot }) => disableAdminSkill(skillId, snapshot),
    onSettled: invalidateSkills
  });

  const manifestMutation = useMutation({
    mutationFn: (url: string | null) => updateTenantMarketplaceManifestUrl(url),
    onSuccess: async (saved) => {
      queryClient.setQueryData<TenantDetails>(queryKeys.admin.tenant(), current => current ? { ...current, settings: { ...current.settings, skillMarketplaceManifestUrl: saved.skillMarketplaceManifestUrl } } : current);
      await Promise.all([invalidateMarketplace(), invalidateTenant()]);
    }
  });

  const [lastAction, setLastAction] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const active = useRef(false);
  const start = async <V, R>(action: string, key: string, mutation: { mutateAsync: (variables: V) => Promise<R> }, variables: V) => {
    if (active.current) throw new Error("Another skill operation is still pending. Wait for it to finish.");
    active.current = true;
    setBusyKey(key);
    setLastAction(action);
    try { return await mutation.mutateAsync(variables); }
    finally { active.current = false; setBusyKey(null); }
  };

  const marketplaceEntry = marketplaceImportMutation.variables;
  const mutationStates: { action: string; mutation: { isPending: boolean; isError: boolean; error: unknown }; fallback: string }[] = [
    { action: "zip", mutation: zipImportMutation, fallback: "Failed to import zip skill bundle." },
    { action: "github", mutation: githubImportMutation, fallback: "Failed to import GitHub skill bundle." },
    { action: "inline", mutation: inlineImportMutation, fallback: "Failed to save inline skill." },
    {
      action: "marketplace",
      mutation: marketplaceImportMutation,
      fallback: `Failed to import ${marketplaceEntry?.name ?? "marketplace entry"} from the marketplace.`
    },
    {
      action: "activate",
      mutation: activateMutation,
      fallback: "Failed to activate skill revision."
    },
    { action: "publish", mutation: publishMutation, fallback: "Failed to publish skill." },
    { action: "unpublish", mutation: unpublishMutation, fallback: "Failed to unpublish skill." },
    { action: "disable", mutation: disableMutation, fallback: "Failed to disable skill." },
    { action: "manifest", mutation: manifestMutation, fallback: "Failed to save marketplace manifest URL." }
  ];

  // Select by status, not by the error value: a rejection with a falsy value
  // ("" or 0) is still a failure and shows the fallback.
  const last = mutationStates.find((state) => state.action === lastAction);
  let error: string | null = null;
  if (last?.mutation.isError) error = toErrorMessage(last.mutation.error, last.fallback);

  return {
    skills: skillsQuery.data ?? [],
    skillsLoaded: skillsQuery.isSuccess,
    libraryState: readState(skillsQuery, data => data.length === 0, "Could not load the skill library."),
    catalogState: readState(marketplaceQuery, data => data.status === "ready" && data.skills.length === 0, "Could not load the marketplace."),
    manifestState: readState(tenantQuery, () => false, "Could not load the saved manifest URL."),
    marketplace: marketplaceQuery.data ?? null,
    manifestUrl: tenantQuery.data === undefined ? undefined : tenantQuery.data.settings.skillMarketplaceManifestUrl ?? null,
    busyKey,
    error,
    handleZipImport: async (file: File): Promise<SkillImportResponse> => {
      return start("zip", "skill-import-zip", zipImportMutation, file);
    },
    handleGithubImport: async (input: {
      githubUrl: string;
      ref?: string;
      subdirectory?: string;
    }): Promise<SkillImportResponse> => {
      return start("github", "skill-import-github", githubImportMutation, input);
    },
    handleInlineImport: async (input: {
      skillId: string;
      skillName: string;
      description: string;
      instructions: string;
    }): Promise<SkillImportResponse> => {
      return start("inline", "skill-import-inline", inlineImportMutation, input);
    },
    handleMarketplaceImport: async (entry: SkillMarketplaceEntry): Promise<SkillImportResponse> => {
      return start("marketplace", `skill-import-marketplace-${entry.slug}`, marketplaceImportMutation, entry);
    },
    handleListRevisions: async (skillId: string): Promise<SkillRevision[]> => {
      return listSkillRevisions(skillId);
    },
    handleActivateRevision: async (input: {
      skillId: string;
      skillRevisionId: number;
      reviewNotes?: string | null;
      audience?: "test-users" | "members";
      expectedSnapshot: AdminSkillReleaseSnapshot;
    }): Promise<void> => {
      await start("activate", `activate-skill-${input.skillId}-${input.skillRevisionId}`, activateMutation, input);
    },
    handlePublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("publish", `publish-skill-${skillId}`, publishMutation, { skillId, snapshot }),
    handleUnpublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("unpublish", `unpublish-skill-${skillId}`, unpublishMutation, { skillId, snapshot }),
    handleDisable: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("disable", `disable-skill-${skillId}`, disableMutation, { skillId, snapshot }),
    handleSaveManifestUrl: async (url: string | null): Promise<void> => {
      await start("manifest", "skill-marketplace-manifest-url", manifestMutation, url);
    }
  };
}
