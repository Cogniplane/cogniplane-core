"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { GithubConnectionSection } from "../../../components/github-connection-section";
import { buildOAuthFlashMessage, OAuthSettingsPage } from "../../../components/oauth-settings-page";
import { useGithubConnection } from "../../../hooks/use-github-connection";

export default function SettingsGithubPage() {
  const searchParams = useSearchParams();
  const { status, busyKey, error, connect, disconnect } = useGithubConnection();

  const flashMessage = useMemo(
    () =>
      buildOAuthFlashMessage({
        provider: "GitHub",
        result: searchParams.get("githubAuth"),
        reason: searchParams.get("reason"),
        successMessage: "GitHub personal authorization connected."
      }),
    [searchParams]
  );

  return (
    <OAuthSettingsPage id="github" provider="GitHub" tenantEnabled={status?.tenantEnabled}>
      <GithubConnectionSection
        busyKey={busyKey}
        error={error}
        flashMessage={flashMessage}
        onConnect={() => void connect()}
        onDisconnect={() => void disconnect()}
        status={status}
      />
    </OAuthSettingsPage>
  );
}
