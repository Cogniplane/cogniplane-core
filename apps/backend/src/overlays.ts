// Attach the bundled SharePoint integration through the overlay contract.
import { bootstrap as sharepointBootstrap } from "@cogniplane-private/sharepoint-overlay-backend";

import type { OverlayBootstrap } from "./overlay-contracts.js";

export const attachOverlays: OverlayBootstrap = sharepointBootstrap;
