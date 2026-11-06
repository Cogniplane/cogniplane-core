"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { buildOAuthFlashMessage } from "../../../../apps/frontend/src/components/oauth-settings-page";
import { MicrosoftConnectionSection } from "../components/microsoft-connection-section";
import { useMicrosoftConnection } from "../hooks/use-microsoft-connection";

export default function SettingsMicrosoftPage() {
  const searchParams = useSearchParams();
  const { status, isLoading, statusError, reload, busyKey, error, connect, disconnect, confirm } = useMicrosoftConnection();

  const flashMessage = useMemo(
    () =>
      // The shared message builder, so `session_changed` reads the same as for GitHub and Notion.
      buildOAuthFlashMessage({
        provider: "Microsoft",
        result: searchParams.get("microsoftAuth"),
        reason: searchParams.get("reason"),
        successMessage: "Microsoft account connected successfully."
      }),
    [searchParams]
  );

  return (
    <MicrosoftConnectionSection
      isLoading={isLoading}
      statusError={statusError}
      onRetry={() => void reload()}
      busyKey={busyKey}
      error={error}
      flashMessage={flashMessage}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onConfirm={confirm}
      status={status}
    />
  );
}
