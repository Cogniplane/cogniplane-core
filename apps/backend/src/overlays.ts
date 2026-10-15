// OSS stub. The private working tree carries a real `overlays.ts` that
// imports private overlay packages (e.g. SharePoint). When the sync script
// builds the public mirror, it replaces the private file with this stub so
// the OSS build has nothing to import.
//
// Adding your own overlay? See docs/overlays.md for the full walkthrough
// (contract, registries, OAuth allowlist propagation, package layout).
// Short version: implement `OverlayBootstrap` from `overlay-contracts.ts` in
// your overlay package and assign it to `attachOverlays` here.

import type { OverlayBootstrap } from "./overlay-contracts.js";

export const attachOverlays: OverlayBootstrap = () => ({
  attachRoutes: () => {}
});
