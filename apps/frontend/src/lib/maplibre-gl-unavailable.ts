// next.config.ts points the "maplibre-gl" import of CopilotKit's standard Map at
// this file. The standard Map loads MapLibre with `import("maplibre-gl")`, an
// optional peer dependency that this app does not install, and MapLibre loads
// map tiles from a third-party host. Generated UI must fetch nothing from a
// host that is not ours, so the generative-UI catalog renders Map as a list of
// locations. Without this alias the production build cannot resolve the import.
// With it, the import rejects, as CopilotKit expects for a missing peer, and no
// map code or tile request exists in the app.
export {};
throw new Error("maplibre-gl is not available: generated maps show a list of locations and load no map tiles.");
