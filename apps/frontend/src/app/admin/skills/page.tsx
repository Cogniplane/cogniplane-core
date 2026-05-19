"use client";

import { useAdminSkillsData } from "../../../hooks/use-admin-skills-data";
import { AdminSkillCard } from "../../../components/admin-skill-card";

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
    handleSaveManifestUrl,
    handleLaunchImprovement,
    handleListImprovementSessions
  } = useAdminSkillsData();

  return (
    <section className="space-y-4" id="skills">
      <div>
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint">
          Registry
        </p>
        <h3 className="text-lg font-bold text-on-surface">Skills</h3>
      </div>
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
        onLaunchImprovement={handleLaunchImprovement}
        onListImprovementSessions={handleListImprovementSessions}
      />
    </section>
  );
}
