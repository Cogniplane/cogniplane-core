// Host entry point for overlay packages: the registration functions.
//
// An overlay frontend imports host code only from the files of this directory.
// `overlay-sdk.test.ts` enforces that. So a host file can move or change its
// name without a change in an overlay: only the paths in this directory change.
//
// The directory has one file for each time of load, because an overlay's
// `register` module loads on every page:
//   registration.ts    the registration functions (every page)
//   ui.ts              shared components (every page)
//   data.ts            API client, query keys and formatters (every page)
//   oauth-settings.ts  parts of an OAuth settings page (loaded with that page)
//
// Each name is a supported surface. Before you change the behavior or the
// signature of one, check the overlays that use it. Add a name when an overlay
// needs it; do not export a whole module. Core does not import these files.

export { registerSettingsSection } from "../app/settings/settings-sections";
export type { FileSourceConnectionState, FileSourceDefinition } from "../components/file-source-picker";
export { registerFileSource, type FileSourceFactoryInput } from "../hooks/use-file-sources";
export { registerArtifactOrigin } from "../lib/artifact-origins";
export { registerPiiScopeLabel } from "../lib/pii-scope-labels";
