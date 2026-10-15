"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

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
  SkillRevision
} from "@cogniplane/shared-types";

function skillBusyKey(action: string, variables: { skillId: string } | undefined): string | null {
  return variables ? `${action}-skill-${variables.skillId}` : null;
}

export function useAdminSkillsData() {
  const queryClient = useQueryClient();

  const skillsQuery = useQuery({
    queryKey: queryKeys.admin.skills(),
    queryFn: listAdminSkills
  });
  const marketplaceQuery = useQuery({
    queryKey: queryKeys.admin.marketplace(),
    queryFn: getSkillMarketplace
  });
  const tenantQuery = useQuery({
    queryKey: queryKeys.admin.tenant(),
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
    onSuccess: () => {
      void invalidateMarketplace();
      void invalidateTenant();
    }
  });

  // The page has one error banner. It shows the result of the action the user
  // started last: a new action clears the old error, and an older action that
  // fails later does not replace the newer action's result.
  const [lastAction, setLastAction] = useState<string | null>(null);
  const start = <V, R>(action: string, mutation: { mutateAsync: (variables: V) => Promise<R> }, variables: V) => {
    setLastAction(action);
    return mutation.mutateAsync(variables);
  };

  // Order is priority: the first pending mutation names busyKey. A busy key of
  // null skips that mutation.
  const marketplaceEntry = marketplaceImportMutation.variables;
  const activation = activateMutation.variables;
  const mutationStates: { action: string; mutation: { isPending: boolean; isError: boolean; error: unknown }; busyKey: string | null; fallback: string }[] = [
    { action: "zip", mutation: zipImportMutation, busyKey: "skill-import-zip", fallback: "Failed to import zip skill bundle." },
    { action: "github", mutation: githubImportMutation, busyKey: "skill-import-github", fallback: "Failed to import GitHub skill bundle." },
    { action: "inline", mutation: inlineImportMutation, busyKey: "skill-import-inline", fallback: "Failed to save inline skill." },
    {
      action: "marketplace",
      mutation: marketplaceImportMutation,
      busyKey: marketplaceEntry ? `skill-import-marketplace-${marketplaceEntry.slug}` : null,
      fallback: `Failed to import ${marketplaceEntry?.name ?? "marketplace entry"} from the marketplace.`
    },
    {
      action: "activate",
      mutation: activateMutation,
      busyKey: activation ? `activate-skill-${activation.skillId}-${activation.skillRevisionId}` : null,
      fallback: "Failed to activate skill revision."
    },
    { action: "publish", mutation: publishMutation, busyKey: skillBusyKey("publish", publishMutation.variables), fallback: "Failed to publish skill." },
    { action: "unpublish", mutation: unpublishMutation, busyKey: skillBusyKey("unpublish", unpublishMutation.variables), fallback: "Failed to unpublish skill." },
    { action: "disable", mutation: disableMutation, busyKey: skillBusyKey("disable", disableMutation.variables), fallback: "Failed to disable skill." },
    { action: "manifest", mutation: manifestMutation, busyKey: "skill-marketplace-manifest-url", fallback: "Failed to save marketplace manifest URL." }
  ];

  const busyKey = mutationStates.find((state) => state.mutation.isPending && state.busyKey)?.busyKey ?? null;
  // Select by status, not by the error value: a rejection with a falsy value
  // ("" or 0) is still a failure and shows the fallback.
  const last = mutationStates.find((state) => state.action === lastAction);
  const failedQuery = [skillsQuery, marketplaceQuery, tenantQuery].find((query) => query.isError);
  let error: string | null = null;
  if (last?.mutation.isError) error = toErrorMessage(last.mutation.error, last.fallback);
  else if (failedQuery) error = toErrorMessage(failedQuery.error, "Failed to load skills.");

  return {
    skills: skillsQuery.data ?? [],
    skillsLoaded: skillsQuery.isSuccess,
    marketplace: marketplaceQuery.data ?? null,
    manifestUrl: tenantQuery.data?.settings.skillMarketplaceManifestUrl ?? null,
    busyKey,
    error,
    handleZipImport: async (file: File): Promise<SkillImportResponse> => {
      return start("zip", zipImportMutation, file);
    },
    handleGithubImport: async (input: {
      githubUrl: string;
      ref?: string;
      subdirectory?: string;
    }): Promise<SkillImportResponse> => {
      return start("github", githubImportMutation, input);
    },
    handleInlineImport: async (input: {
      skillId: string;
      skillName: string;
      description: string;
      instructions: string;
    }): Promise<SkillImportResponse> => {
      return start("inline", inlineImportMutation, input);
    },
    handleMarketplaceImport: async (entry: SkillMarketplaceEntry): Promise<SkillImportResponse> => {
      return start("marketplace", marketplaceImportMutation, entry);
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
      await start("activate", activateMutation, input);
    },
    handlePublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("publish", publishMutation, { skillId, snapshot }),
    handleUnpublish: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("unpublish", unpublishMutation, { skillId, snapshot }),
    handleDisable: (skillId: string, snapshot: AdminSkillReleaseSnapshot) => start("disable", disableMutation, { skillId, snapshot }),
    handleSaveManifestUrl: async (url: string | null): Promise<void> => {
      await start("manifest", manifestMutation, url);
    }
  };
}
