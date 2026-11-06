import type { AttachOverlaysInput } from "../../../../apps/backend/src/overlay-contracts.js";
import {
  registerIntegration,
  getIntegrationDescriptor,
  type IntegrationConnectionProbe,
  type IntegrationOAuthRoutes
} from "../../../../apps/backend/src/services/integrations/integration-registry.js";
import type { MicrosoftConnectionService } from "../services/microsoft-connection-service.js";
import { loadOverlayConfig } from "../config.js";
import {
  MICROSOFT_OAUTH_CALLBACK_PATHS,
  registerMicrosoftOAuthRoutes
} from "../services/microsoft-oauth-routes.js";

// Microsoft 365 integration descriptor. Registered from the overlay's
// bootstrap so the OSS subset (no Microsoft) can ship without dragging the
// connection service into core.

export function registerMicrosoftDescriptor(): void {
  registerIntegration({
    id: "microsoft",
    name: "Microsoft 365",
    description: "Browse SharePoint sites, OneDrive files, search across tenant content.",
    longDescription:
      "Tenant configures a Microsoft Entra ID OAuth app; users authorize their accounts. The agent can list sites, browse files, search, read content, and (with writes enabled) upload files and create folders.",
    logoSlug: "microsoft",
    status: "available",
    category: "Productivity",
    readToolIds: [
      "sharepoint_list_sites",
      "sharepoint_list_files",
      "sharepoint_read_file",
      "sharepoint_search"
    ],
    writeToolIds: [
      "sharepoint_upload_file",
      "sharepoint_create_folder",
      "sharepoint_import_file_to_session"
    ],
    configMode: "oauth_app",
    configFields: [
      { key: "clientId", label: "Application (client) ID", type: "text", required: true },
      {
        key: "clientSecret",
        label: "Client secret",
        type: "password",
        required: true,
        helpText: "Stored encrypted at rest."
      },
      {
        key: "entraTenantId",
        label: "Directory (tenant) ID",
        type: "text",
        required: true,
        helpText: "Your Microsoft Entra tenant ID."
      }
    ],
    setupHelp:
      "Provide the credentials from your Microsoft Entra app registration to allow users to connect their accounts.",
    docsUrl:
      "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
    platformStatus: () => {
      const config = loadOverlayConfig();
      if (!config.MICROSOFT_OAUTH_REDIRECT_URI) {
        return {
          configured: false,
          message: "MICROSOFT_OAUTH_REDIRECT_URI is not configured."
        };
      }
      return { configured: true, message: null };
    },
    oauthCallbackPaths: MICROSOFT_OAUTH_CALLBACK_PATHS
  });
}

export function attachMicrosoftRuntimeWiring(registry: AttachOverlaysInput["integrationDescriptors"], input: {
  probe: IntegrationConnectionProbe;
  oauthCallback: MicrosoftConnectionService;
  limits?: AttachOverlaysInput["limits"];
}): void {
  const descriptor = getIntegrationDescriptor("microsoft");
  if (!descriptor) throw new Error("Microsoft descriptor must be registered before attaching its hooks");
  if (!registry.get("microsoft")) registry.register(descriptor);
  registry.setRuntimeWiring("microsoft", {
    connectionProbe: input.probe,
    oauthRoutes: buildMicrosoftOAuthRoutes(input.oauthCallback, input.limits)
  });
}

function buildMicrosoftOAuthRoutes(
  callbackHandler: MicrosoftConnectionService | undefined,
  limits?: AttachOverlaysInput["limits"]
): IntegrationOAuthRoutes {
  return {
    paths: MICROSOFT_OAUTH_CALLBACK_PATHS,
    register: callbackHandler
      ? (app) => registerMicrosoftOAuthRoutes(app, callbackHandler, limits)
      : () => {}
  };
}
