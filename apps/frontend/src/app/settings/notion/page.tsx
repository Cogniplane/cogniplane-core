"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { NotionConnectionSection } from "../../../components/notion-connection-section";
import { useNotionConnection } from "../../../hooks/use-notion-connection";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

function buildFlashMessage(notionAuth: string | null, reason: string | null): string | null {
  if (notionAuth === "connected") {
    return "Notion account connected successfully.";
  }
  if (notionAuth === "error") {
    return reason
      ? `Notion authorization failed: ${reason.replaceAll("_", " ")}.`
      : "Notion authorization failed.";
  }
  return null;
}

export default function SettingsNotionPage() {
  const searchParams = useSearchParams();
  const { status, busyKey, error, connect, disconnect } = useNotionConnection();

  const flashMessage = useMemo(
    () =>
      buildFlashMessage(searchParams.get("notionAuth"), searchParams.get("reason")),
    [searchParams]
  );

  if (status && status.tenantEnabled === false) {
    return (
      <section id="notion" className="flex flex-col gap-5">
        <div>
          <p className={SECTION_LABEL}>Live module</p>
          <h3 className="text-lg font-semibold text-on-surface">Notion</h3>
        </div>
        <p className="text-sm text-on-surface-faint">
          Notion is not enabled for this tenant. Ask an administrator to enable it from the
          Integrations page.
        </p>
      </section>
    );
  }

  return (
    <NotionConnectionSection
      busyKey={busyKey}
      error={error}
      flashMessage={flashMessage}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      status={status}
    />
  );
}
