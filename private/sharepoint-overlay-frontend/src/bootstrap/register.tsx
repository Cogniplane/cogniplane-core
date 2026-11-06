"use client";

// Overlay bootstrap. Registers:
//   1. The Microsoft 365 settings section: the account row on Connected
//      accounts, and the detail page that the host's generic
//      `/settings/[integrationId]` route renders at `/settings/microsoft`.
//   2. The Microsoft file-source factory in the file-source picker.
//   3. The "Microsoft import" origin label in the artifact panel.
//   4. The label of the Microsoft imports scope in the PII settings.
//
// Imported as a side effect from the host frontend's
// `apps/frontend/src/overlays.ts`.

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { registerSettingsSection } from "../../../../apps/frontend/src/app/settings/settings-sections";
import { registerArtifactOrigin } from "../../../../apps/frontend/src/lib/artifact-origins";
import { registerPiiScopeLabel } from "../../../../apps/frontend/src/lib/pii-scope-labels";
import {
  registerFileSource,
  type FileSourceFactoryInput
} from "../../../../apps/frontend/src/hooks/use-file-sources";
import type {
  FileSourceConnectionState,
  FileSourceDefinition
} from "../../../../apps/frontend/src/components/file-source-picker";

import { MicrosoftFileSourceBody } from "../components/microsoft-file-source";
import { MicrosoftConnectedAccountRow } from "../components/microsoft-connected-account-row";
import { useMicrosoftFileSelector } from "../hooks/use-microsoft-file-selector";

// The settings page loads on demand. This file loads on every page, and only
// /settings/microsoft needs the page code.
const SettingsMicrosoftPage = dynamic(() => import("../pages/microsoft-settings"), {
  loading: () => <p role="status" className="text-sm text-on-surface-variant">Loading Microsoft 365 settings…</p>
});

registerSettingsSection({
  id: "microsoft",
  label: "Microsoft 365",
  kind: "integration",
  accountRow: MicrosoftConnectedAccountRow,
  detail: SettingsMicrosoftPage,
  subtitle: "Link OneDrive, SharePoint, and Graph integrations."
});

// The import route stores `detail.source = "microsoft"` on each artifact.
registerArtifactOrigin({ detailSource: "microsoft", label: "Microsoft import", tone: "accent" });

// The backend overlay registers this scope key for its imports.
registerPiiScopeLabel({ scopeKey: "microsoftImports", label: "Microsoft imports" });

registerFileSource({
  integrationId: "microsoft",
  useEntry: (input: FileSourceFactoryInput): FileSourceDefinition => {
    const microsoft = useMicrosoftFileSelector(input);
    const userConnection = microsoft.connectionStatus?.userConnection ?? null;
    const connection: FileSourceConnectionState = userConnection
      ? {
          kind: "connected",
          label:
            userConnection.microsoftDisplayName ??
            userConnection.microsoftEmail ??
            "Microsoft user"
        }
      : {
          kind: "disconnected",
          label:
            "Connect Microsoft in settings to import deterministic context from OneDrive and SharePoint.",
          settingsHref: "/settings/microsoft"
        };

    const renderBody = ({
      selectedSessionId
    }: {
      selectedSessionId: string | null;
    }): ReactNode => (
      <MicrosoftFileSourceBody
        browseItems={microsoft.browseItems}
        browseStack={microsoft.browseStack}
        importFile={microsoft.importFile}
        importingItemId={microsoft.importingItemId}
        isLoadingBrowse={microsoft.isLoadingBrowse}
        isLoadingSites={microsoft.isLoadingSites}
        isSearching={microsoft.isSearching}
        navigateToBreadcrumb={microsoft.navigateToBreadcrumb}
        openFolder={microsoft.openFolder}
        openOneDriveRoot={microsoft.openOneDriveRoot}
        openSite={microsoft.openSite}
        refreshSites={microsoft.refreshSites}
        runSearch={microsoft.runSearch}
        searchQuery={microsoft.searchQuery}
        searchResults={microsoft.searchResults}
        selectedSessionId={selectedSessionId}
        setSearchQuery={microsoft.setSearchQuery}
        setSiteSearch={microsoft.setSiteSearch}
        siteSearch={microsoft.siteSearch}
        sites={microsoft.sites}
      />
    );

    return {
      id: "microsoft",
      label: "Microsoft 365",
      description: "OneDrive and SharePoint",
      connection,
      renderBody
    };
  }
});
