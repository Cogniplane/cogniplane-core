"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { GithubConnectionSection } from "../../../components/github-connection-section";
import { useGithubConnection } from "../../../hooks/use-github-connection";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

function buildFlashMessage(githubAuth: string | null, reason: string | null): string | null {
  if (githubAuth === "connected") {
    return "GitHub personal authorization connected.";
  }
  if (githubAuth === "error") {
    return reason
      ? `GitHub authorization failed: ${reason.replaceAll("_", " ")}.`
      : "GitHub authorization failed.";
  }
  return null;
}

export default function SettingsGithubPage() {
  const searchParams = useSearchParams();
  const { status, busyKey, error, connect, disconnect } = useGithubConnection();

  const flashMessage = useMemo(
    () =>
      buildFlashMessage(searchParams.get("githubAuth"), searchParams.get("reason")),
    [searchParams]
  );

  if (status && status.tenantEnabled === false) {
    return (
      <section id="github" className="flex flex-col gap-5">
        <div>
          <p className={SECTION_LABEL}>Live module</p>
          <h3 className="text-lg font-semibold text-on-surface">GitHub</h3>
        </div>
        <p className="text-sm text-on-surface-faint">
          GitHub is not enabled for this tenant. Ask an administrator to enable it from the
          Integrations page.
        </p>
      </section>
    );
  }

  return (
    <GithubConnectionSection
      busyKey={busyKey}
      error={error}
      flashMessage={flashMessage}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      status={status}
    />
  );
}
