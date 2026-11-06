// Side-panel views that the user is not looking at.
//
// CopilotKit 1.83.0 shows one surface for a target: the newest one that has
// that target (`getSurfaceForTarget`), and no public renderer takes a surface
// id. The host gives every panel view except the selected one this target,
// which nothing mounts, as it already does for a withdrawn preview.
// `ingest` sets the target again and keeps the surface: no rebuild, no
// operation applied twice, and the values of the user stay.
//
// The manager then lists those views under this target. Every reader of
// `describeSurfaces` must read them as panel views, or a view that the user
// left would drop out of the values that the next message sends and out of
// the saved drafts. `canonicalTarget` is that reading.

import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";

/** The target of a panel view that the panel does not show now. */
export const PARKED_PANEL_TARGET = `${GENERATIVE_UI_PANEL_TARGET}:parked`;

/** A view removed by authoritative history. Its values must not be sent. */
export const REMOVED_PANEL_TARGET = `${GENERATIVE_UI_PANEL_TARGET}:removed`;

/** The target that the model gave a view, whether or not the panel shows it now. */
export function canonicalTarget(target: string): string {
  return target === PARKED_PANEL_TARGET ? GENERATIVE_UI_PANEL_TARGET : target;
}
