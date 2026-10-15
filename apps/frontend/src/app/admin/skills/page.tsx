"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { listAdminSkillSubmissions } from "@/lib/organization-skill-submissions-api";
import { queryKeys } from "@/lib/query-keys";
import { useAdminSkillsData } from "../../../hooks/use-admin-skills-data";
import { AdminSkillCard } from "../../../components/admin/skills/admin-skill-card";
import { OrganizationSkillReview } from "../../../components/admin/skills/organization-skill-review";

export default function AdminSkillsPage() {
  const params = useSearchParams();
  const urlKey = params.toString();
  const urlView = params.get("view") === "review" ? "review" : "library";
  const submissionId = params.get("submission");
  const targetSkillId = params.get("skill");
  const [viewOverride, setView] = useState<{ urlKey: string; view: "library" | "review" } | null>(null);
  const view = viewOverride?.urlKey === urlKey ? viewOverride.view : urlView;
  const [reviewCountResult, setReviewCount] = useState<{ scope: string; count: number | null } | null>(null);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const userId = user?.userId;
  const scopeKey = `${tenantId ?? ""}:${userId ?? ""}`;
  const reviewCount = reviewCountResult?.scope === scopeKey ? reviewCountResult.count : null;
  const refreshCount = useCallback(async () => {
    if (!tenantId || !userId) return;
    try {
      const result = await listAdminSkillSubmissions();
      setReviewCount({ scope: scopeKey, count: result.scope.tenantId === tenantId && result.scope.userId === userId
        ? result.submissions.filter((item) => item.status === "pending").length : null });
    } catch { setReviewCount({ scope: scopeKey, count: null }); }
  }, [tenantId, userId, scopeKey]);
  useEffect(() => { let active = true; if (tenantId && userId) listAdminSkillSubmissions().then((result) => {
    if (!active) return;
    setReviewCount({ scope: scopeKey, count: result.scope.tenantId === tenantId && result.scope.userId === userId
      ? result.submissions.filter((item) => item.status === "pending").length : null });
  }).catch(() => { if (active) setReviewCount({ scope: scopeKey, count: null }); });
    return () => { active = false; }; }, [tenantId, userId, scopeKey]);
  const {
    skills,
    skillsLoaded,
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
      <div className="flex gap-1 border-b border-outline-variant" role="group" aria-label="Skills view">
        <button type="button" aria-pressed={view === "library"} onClick={() => setView({ urlKey, view: "library" })} className={`border-b-2 px-4 py-2 text-sm font-medium ${view === "library" ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}>Library</button>
        <button type="button" aria-pressed={view === "review"} onClick={() => setView({ urlKey, view: "review" })} className={`border-b-2 px-4 py-2 text-sm font-medium ${view === "review" ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}>Review{reviewCount ? <span className="ml-2 rounded bg-warning-surface px-1.5 py-0.5 text-xs text-warning">{reviewCount}</span> : null}</button>
      </div>
      {view === "review" ? <OrganizationSkillReview requestedSubmissionId={submissionId} key={`${tenantId ?? ""}:${userId ?? ""}:${submissionId ?? ""}`} onQueueChanged={() => { void refreshCount(); void queryClient.invalidateQueries({ queryKey: queryKeys.admin.skills() }); if (tenantId && userId) void queryClient.invalidateQueries({ queryKey: queryKeys.admin.skillSubmissions(tenantId, userId) }); }} onOpenLibrary={() => { void queryClient.invalidateQueries({ queryKey: queryKeys.admin.skills() }); setView({ urlKey, view: "library" }); }} /> : <>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {targetSkillId && skillsLoaded && !skills.some((skill) => skill.skillId === targetSkillId) ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-outline-variant bg-surface-container-low px-4 py-3 text-sm">
          <p className="text-on-surface">The skill <code className="font-mono text-xs">{targetSkillId}</code> is not in the library. It may have been removed.</p>
          <Link href="/admin/skills" className="font-medium text-primary underline underline-offset-4">Show all skills</Link>
        </div>
      ) : null}
      <AdminSkillCard
        targetSkillId={targetSkillId}
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
      </>}
    </section>
  );
}
