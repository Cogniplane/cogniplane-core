// Public exports of the SharePoint frontend overlay.
//
// Consumers in the private working tree:
//   - `apps/frontend/src/overlays.ts` side-effect imports
//     `@cogniplane-private/sharepoint-overlay-frontend/register`. That entry
//     registers the settings section (account row and the detail page for
//     `/settings/microsoft`) and the file-source factory.
//
// On the OSS subset `overlays.ts` is a no-op stub and `private/**` is not
// synced, so none of these consumers exist in the public tree.

export { MicrosoftConnectionSection } from "./components/microsoft-connection-section";
export { useMicrosoftConnection } from "./hooks/use-microsoft-connection";
export { useMicrosoftFileSelector } from "./hooks/use-microsoft-file-selector";
export { MicrosoftFileSourceBody } from "./components/microsoft-file-source";
