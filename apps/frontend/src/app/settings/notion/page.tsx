"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { NotionConnectionSection } from "../../../components/notion-connection-section";
import { buildOAuthFlashMessage, OAuthSettingsPage } from "../../../components/oauth-settings-page";
import { useNotionConnection } from "../../../hooks/use-notion-connection";

export default function SettingsNotionPage() {
  const searchParams = useSearchParams();
  const { status, busyKey, error, connect, disconnect } = useNotionConnection();

  const flashMessage = useMemo(
    () =>
      buildOAuthFlashMessage({
        provider: "Notion",
        result: searchParams.get("notionAuth"),
        reason: searchParams.get("reason"),
        successMessage: "Notion account connected successfully."
      }),
    [searchParams]
  );

  return (
    <OAuthSettingsPage id="notion" provider="Notion" tenantEnabled={status?.tenantEnabled}>
      <NotionConnectionSection
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
