"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  SkillMarketplaceEntry,
  SkillRevision
} from "@cogniplane/shared-types";

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
      await importAdminSkillGithub({
        githubUrl: entry.repositoryUrl,
        ref: entry.ref,
        subdirectory: entry.subdirectory
      });
      return entry;
    },
    onSuccess: invalidateSkills
  });

  const activateMutation = useMutation({
    mutationFn: activateSkillRevision,
    onSuccess: invalidateSkills
  });

  const publishMutation = useMutation({
    mutationFn: publishAdminSkill,
    onSuccess: invalidateSkills
  });

  const unpublishMutation = useMutation({
    mutationFn: unpublishAdminSkill,
    onSuccess: invalidateSkills
  });

  const disableMutation = useMutation({
    mutationFn: disableAdminSkill,
    onSuccess: invalidateSkills
  });

  const manifestMutation = useMutation({
    mutationFn: (url: string | null) => updateTenantMarketplaceManifestUrl(url),
    onSuccess: () => {
      void invalidateMarketplace();
      void invalidateTenant();
    }
  });

  let busyKey: string | null = null;
  if (zipImportMutation.isPending) busyKey = "skill-import-zip";
  else if (githubImportMutation.isPending) busyKey = "skill-import-github";
  else if (inlineImportMutation.isPending) busyKey = "skill-import-inline";
  else if (marketplaceImportMutation.isPending && marketplaceImportMutation.variables)
    busyKey = `skill-import-marketplace-${marketplaceImportMutation.variables.slug}`;
  else if (activateMutation.isPending && activateMutation.variables)
    busyKey = `activate-skill-${activateMutation.variables.skillId}-${activateMutation.variables.skillRevisionId}`;
  else if (publishMutation.isPending && publishMutation.variables)
    busyKey = `publish-skill-${publishMutation.variables}`;
  else if (unpublishMutation.isPending && unpublishMutation.variables)
    busyKey = `unpublish-skill-${unpublishMutation.variables}`;
  else if (disableMutation.isPending && disableMutation.variables)
    busyKey = `disable-skill-${disableMutation.variables}`;
  else if (manifestMutation.isPending) busyKey = "skill-marketplace-manifest-url";

  const pendingMutation =
    zipImportMutation.error ??
    githubImportMutation.error ??
    inlineImportMutation.error ??
    marketplaceImportMutation.error ??
    activateMutation.error ??
    publishMutation.error ??
    unpublishMutation.error ??
    disableMutation.error ??
    manifestMutation.error;

  const errorFallback = zipImportMutation.error
    ? "Failed to import zip skill bundle."
    : githubImportMutation.error
      ? "Failed to import GitHub skill bundle."
      : inlineImportMutation.error
        ? "Failed to save inline skill."
        : marketplaceImportMutation.error
        ? `Failed to import ${marketplaceImportMutation.variables?.name ?? "marketplace entry"} from the marketplace.`
        : activateMutation.error
          ? "Failed to activate skill revision."
          : publishMutation.error
            ? "Failed to publish skill."
            : unpublishMutation.error
              ? "Failed to unpublish skill."
              : disableMutation.error
                ? "Failed to disable skill."
                : manifestMutation.error
                  ? "Failed to save marketplace manifest URL."
                  : "Failed to load skills.";
  const loadError = skillsQuery.error ?? marketplaceQuery.error ?? tenantQuery.error;
  const currentError = pendingMutation ?? loadError;

  return {
    skills: skillsQuery.data ?? [],
    marketplace: marketplaceQuery.data ?? null,
    manifestUrl: tenantQuery.data?.settings.skillMarketplaceManifestUrl ?? null,
    busyKey,
    error: currentError ? toErrorMessage(currentError, errorFallback) : null,
    handleZipImport: async (file: File): Promise<void> => {
      await zipImportMutation.mutateAsync(file);
    },
    handleGithubImport: async (input: {
      githubUrl: string;
      ref?: string;
      subdirectory?: string;
    }): Promise<void> => {
      await githubImportMutation.mutateAsync(input);
    },
    handleInlineImport: async (input: {
      skillId: string;
      skillName: string;
      description: string;
      instructions: string;
    }): Promise<void> => {
      await inlineImportMutation.mutateAsync(input);
    },
    handleMarketplaceImport: async (entry: SkillMarketplaceEntry): Promise<void> => {
      await marketplaceImportMutation.mutateAsync(entry);
    },
    handleListRevisions: async (skillId: string): Promise<SkillRevision[]> => {
      return listSkillRevisions(skillId);
    },
    handleActivateRevision: async (input: {
      skillId: string;
      skillRevisionId: number;
      reviewNotes?: string | null;
    }): Promise<void> => {
      await activateMutation.mutateAsync(input);
    },
    handlePublish: (skillId: string) => publishMutation.mutate(skillId),
    handleUnpublish: (skillId: string) => unpublishMutation.mutate(skillId),
    handleDisable: (skillId: string) => disableMutation.mutate(skillId),
    handleSaveManifestUrl: async (url: string | null): Promise<void> => {
      await manifestMutation.mutateAsync(url);
    }
  };
}
