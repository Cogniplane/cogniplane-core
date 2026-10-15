"use client";

import type { SessionCapabilitySelection } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";

type Catalog = {
  selection: SessionCapabilitySelection | null;
  skills: Array<{ id: string; name: string }>;
  connectors: Array<{ id: string; name: string }>;
};
export type CapabilityConflict = { addedElsewhere: string[]; removedByDraft: string[]; restoredByDraft: string[] };

const keys = ["skillIds", "connectorIds"] as const;
// A null selection inherits the whole catalog.
const effective = (selection: SessionCapabilitySelection | null, catalog: Catalog): SessionCapabilitySelection =>
  selection ?? { skillIds: catalog.skills.map((item) => item.id), connectorIds: catalog.connectors.map((item) => item.id) };

/**
 * Compares a draft with the settings that a 409 reload returned. It lists the
 * resources that another save added, the resources that this draft removes
 * from the current settings, and the resources that another save removed but
 * this draft still holds. It returns null when all lists are empty.
 */
export function capabilityConflict(before: Catalog, after: Catalog, draft: SessionCapabilitySelection | null): CapabilityConflict | null {
  const prior = effective(before.selection, before);
  const current = effective(after.selection, after);
  const next = effective(draft, after);
  const names = new Map([...before.skills, ...before.connectors, ...after.skills, ...after.connectors]
    .map((item) => [item.id, item.name]));
  const missing = (from: SessionCapabilitySelection, other: SessionCapabilitySelection) =>
    keys.flatMap((key) => from[key].filter((id) => !other[key].includes(id))).map((id) => names.get(id) ?? id);
  // In the draft and in the old settings, but not in the current settings.
  const removedElsewhere = { skillIds: next.skillIds.filter((id) => prior.skillIds.includes(id)),
    connectorIds: next.connectorIds.filter((id) => prior.connectorIds.includes(id)) };
  const result = { addedElsewhere: missing(current, prior), removedByDraft: missing(current, next),
    restoredByDraft: missing(removedElsewhere, current) };
  return result.addedElsewhere.length || result.removedByDraft.length || result.restoredByDraft.length ? result : null;
}

export function CapabilityConflictNotice({ conflict, disabled, onKeep }: {
  conflict: CapabilityConflict; disabled: boolean; onKeep: () => void;
}) {
  return <div role="status" className="space-y-2 rounded-md border border-outline-variant p-3 text-sm">
    <p>These settings changed while you were editing. Review the differences before you save.</p>
    {conflict.addedElsewhere.length ? <p>Added elsewhere: {conflict.addedElsewhere.join(", ")}</p> : null}
    {conflict.removedByDraft.length ? <p>Your save removes: {conflict.removedByDraft.join(", ")}</p> : null}
    {conflict.restoredByDraft.length ? <p>Removed elsewhere, your save restores: {conflict.restoredByDraft.join(", ")}</p> : null}
    <Button size="sm" variant="outline" disabled={disabled} onClick={onKeep}>Keep my changes</Button>
  </div>;
}
