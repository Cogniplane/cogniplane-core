"use client";

import { useAdminSkillsData } from "../../../hooks/use-admin-skills-data";
import { AdminSkillCard } from "../../../components/admin/skills/admin-skill-card";

export default function AdminSkillsPage() {
  const {
    skills,
    marketplace,
    manifestUrl,
    busyKey,
    error,
    handleZipImport,
    handleGithubImport,
    handleInlineImport,
    handleMarketplaceImport,
    handleListRevisions,
    handleActivateRevision,
    handlePublish,
    handleUnpublish,
    handleDisable,
    handleSaveManifestUrl
  } = useAdminSkillsData();

  return (
    <section className="space-y-4 pt-5" id="skills">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <AdminSkillCard
        skills={skills}
        marketplace={marketplace}
        manifestUrl={manifestUrl}
        busyKey={busyKey}
        onDisable={handleDisable}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        onImportZip={handleZipImport}
        onImportGithub={handleGithubImport}
        onImportInline={handleInlineImport}
        onImportMarketplace={handleMarketplaceImport}
        onListRevisions={handleListRevisions}
        onActivateRevision={handleActivateRevision}
        onSaveManifestUrl={handleSaveManifestUrl}
      />
    </section>
  );
}
