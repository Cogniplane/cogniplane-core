// @vitest-environment jsdom
import type { Artifact } from "@cogniplane/shared-types";
import { expect, it } from "vitest";

import { microsoftQueryKeys } from "../../../private/sharepoint-overlay-frontend/src/lib/query-keys";
import { getArtifactOrigin } from "./components/artifact-panel.logic";
import { piiScopeLabel } from "./lib/pii-scope-labels";
import "./overlays";

// It uses the real overlay registration, with no mock.

it("labels an artifact that the Microsoft import stored as a Microsoft import", () => {
  // The overlay backend stores detail.source = "microsoft" on each import.
  const artifact = { artifactType: "upload", createdByType: "user", detail: { source: "microsoft" } } as unknown as Artifact;

  expect(getArtifactOrigin(artifact)).toEqual({ label: "Microsoft import", tone: "accent" });
});

it("keeps the Microsoft query keys that existed before they moved out of core", () => {
  expect(microsoftQueryKeys.settings()).toEqual(["settings", "microsoft"]);
  expect(microsoftQueryKeys.all).toEqual(["microsoft"]);
  expect(microsoftQueryKeys.connectionStatus()).toEqual(["microsoft", "connection-status"]);
  expect(microsoftQueryKeys.sites("q")).toEqual(["microsoft", "sites", "q"]);
  const location = { siteId: "s", driveId: "d", folderId: null };
  expect(microsoftQueryKeys.browse(location)).toEqual(["microsoft", "browse", location]);
  expect(microsoftQueryKeys.search("q")).toEqual(["microsoft", "search", "q"]);
});

it("labels the PII scope that the overlay backend registers for Microsoft imports", () => {
  // The backend overlay registers this scope key; the stored policy keeps it.
  expect(piiScopeLabel("microsoftImports")).toBe("Microsoft imports");
});
