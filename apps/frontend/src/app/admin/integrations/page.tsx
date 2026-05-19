"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { AdminIntegrationsList } from "../../../components/admin-integrations-list";

function buildInstallFlash(
  githubInstall: string | null,
  reason: string | null
): { error: string | null; success: string | null } {
  if (githubInstall === "connected") {
    return { error: null, success: "GitHub App installed for this organization." };
  }
  if (githubInstall === "error") {
    return {
      error: reason
        ? `GitHub App installation failed: ${reason.replaceAll("_", " ")}.`
        : "GitHub App installation failed.",
      success: null
    };
  }
  return { error: null, success: null };
}

export default function AdminIntegrationsPage() {
  const searchParams = useSearchParams();
  const flash = useMemo(
    () =>
      buildInstallFlash(
        searchParams.get("githubInstall"),
        searchParams.get("reason")
      ),
    [searchParams]
  );

  return (
    <>
      {flash.error ? <p className="text-sm text-danger">{flash.error}</p> : null}
      {flash.success ? <p className="text-sm text-on-surface-faint">{flash.success}</p> : null}
      <AdminIntegrationsList />
    </>
  );
}
