"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PersonalCapabilities, SessionCapabilitySelection } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { getPersonalCapabilities, updatePersonalCapabilities } from "@/lib/personal-capabilities-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectorAccountStatus } from "@/components/connector-account-status";
import { capabilityConflict, CapabilityConflictNotice, type CapabilityConflict } from "./capability-conflict";

type CatalogKey = keyof SessionCapabilitySelection;
const sameSelection = (a: SessionCapabilitySelection | null, b: SessionCapabilitySelection | null) =>
  a === null || b === null ? a === b :
    (["skillIds", "connectorIds"] as const).every((key) =>
      a[key].length === b[key].length && a[key].every((id) => b[key].includes(id)));

export function PersonalCapabilitiesForm({ expectedScope, onDirtyChange }: { expectedScope: PersonalCapabilities["scope"]; onDirtyChange?: (dirty: boolean) => void }) {
  const [data, setData] = useState<PersonalCapabilities | null>(null);
  const [draft, setDraft] = useState<SessionCapabilitySelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Differences found after a 409. Save stays blocked until the user keeps their changes.
  const [conflictDetails, setConflictDetails] = useState<CapabilityConflict | null>(null);
  const [scopeMismatch, setScopeMismatch] = useState(false);
  const [search, setSearch] = useState("");
  const { tenantId, userId } = expectedScope;
  const acceptScope = useCallback((result: PersonalCapabilities) => {
    if (result.scope.tenantId === tenantId && result.scope.userId === userId) return true;
    setScopeMismatch(true);
    setData(null);
    setDraft(null);
    setError(null);
    return false;
  }, [tenantId, userId]);

  useEffect(() => {
    let active = true;
    getPersonalCapabilities().then((result) => {
      if (!active) return;
      if (!acceptScope(result)) return;
      setData(result);
      setDraft(result.selection);
      setError(null);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load your defaults.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [acceptScope]);

  const reload = useCallback(async (keepDraft = false): Promise<PersonalCapabilities | null> => {
    if (scopeMismatch) return null;
    setLoading(true);
    setError(null);
    try {
      const result = await getPersonalCapabilities();
      if (!acceptScope(result)) return null;
      setData(result);
      if (!keepDraft) { setDraft(result.selection); setConflictDetails(null); }
      setConflict(false);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your defaults.");
      return null;
    } finally { setLoading(false); }
  }, [acceptScope, scopeMismatch]);

  const editable = data?.canEdit === true && !scopeMismatch;
  const dirty = Boolean(data && !sameSelection(data.selection, draft));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const toggle = (key: CatalogKey, id: string) => {
    setConflict(false);
    setDraft((current) => current && ({ ...current,
      [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id]
    }));
  };
  const save = async () => {
    if (!data || !editable || !dirty || saving || loading || scopeMismatch || (conflict && error) || conflictDetails) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updatePersonalCapabilities({ selection: draft, version: data.version, scope: data.scope });
      if (!acceptScope(result)) return;
      setData(result);
      setDraft(result.selection);
      setSearch("");
      setConflict(false);
      setConflictDetails(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your defaults.");
      if (cause instanceof ApiError && cause.code === "capabilities_scope_changed") {
        setScopeMismatch(true);
        setData(null);
        setDraft(null);
      } else if (cause instanceof ApiError && cause.status === 409) {
        const reloaded = await reload(true);
        setConflict(true);
        setConflictDetails(reloaded ? capabilityConflict(data, reloaded, draft) : null);
        if (!reloaded) setError("Your defaults changed, but their current values could not be loaded. Reload before saving.");
      } else if (cause instanceof ApiError && cause.status === 403) {
        setData((current) => current && { ...current, canEdit: false });
        await reload(true);
      }
    } finally { setSaving(false); }
  };

  return <section aria-labelledby="personal-capabilities-title" className="space-y-5 pt-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2 text-sm text-on-surface-variant">
        <h2 id="personal-capabilities-title" className="text-base font-semibold text-on-surface">Your chat defaults</h2>
        <p>Choose the organization skills, your available private skills, and approved connections for your standalone chats. Changes apply on the next turn.</p>
        <p>Projects and scheduled jobs use their own settings. To connect an account or approve a connection, visit <Link href="/settings/connections" className="font-medium text-on-surface underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">Connected accounts</Link>.</p>
      </div>
      {data && editable && draft === null ? <Button size="sm" variant="outline" disabled={loading || saving}
        onClick={() => setDraft({ skillIds: data.skills.map((item) => item.id), connectorIds: data.connectors.map((item) => item.id) })}>Customize</Button> : null}
    </div>
    {loading && !data ? <div aria-label="Loading personal capabilities" className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}
    {scopeMismatch ? <div role="alert" className="space-y-2 text-sm text-danger">
      <p>Your account or organization changed. Reload this page before editing these defaults.</p>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
    </div> : null}
    {error && !scopeMismatch ? <div role="alert" className="text-sm text-danger"><p>{error}</p>
      <Button size="sm" variant="outline" className="mt-2" disabled={loading || saving} onClick={() => void reload(dirty)}>Reload defaults</Button>
    </div> : null}
    {data ? <div className="space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-5">
      <div className="space-y-1">
        <p className="text-sm font-medium">{draft === null ? "Using inherited defaults" : "Custom selection"}</p>
        <p className="text-sm text-on-surface-variant">{draft === null
          ? "Organization defaults and your available private skills appear here automatically."
          : "Only selected resources are included. New organization or private skills stay out until you add them."}</p>
      </div>
      {!editable ? <p className="text-sm text-on-surface-variant">Your defaults are read-only right now.</p> : null}
      {draft !== null ? <>
        {editable ? <div className="max-w-md"><label htmlFor="personal-capabilities-search" className="text-sm font-medium">Add skills or connections</label>
          <Input id="personal-capabilities-search" type="search" className="mt-1" value={search}
            onChange={(event) => setSearch(event.target.value)} placeholder="Search skills and connections" disabled={loading || saving} /></div> : null}
        {(["skillIds", "connectorIds"] as const).map((key) => {
          const catalog = key === "skillIds" ? data.skills : data.connectors;
          const label = key === "skillIds" ? "Skills" : "Connections";
          const known = new Map(catalog.map((item) => [item.id, item]));
          const selected = draft[key].map((id) => known.get(id) ?? { id, name: "Unavailable resource", description: "This selection is no longer in the available library." });
          const available = catalog.filter((item) => !draft[key].includes(item.id) &&
            `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
          return <div key={key} className="space-y-2">
            <h3 className="text-sm font-semibold">{label}</h3>
            {selected.length === 0 ? <p className="text-sm text-on-surface-variant">No {label.toLowerCase()} selected.</p> :
              <ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">{selected.map((item, index) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span className="min-w-0"><span className="block font-medium">{item.name} {"source" in item && item.source === "personal" ? <span className="ml-1 rounded-full border border-outline-variant px-1.5 py-0.5 text-[10px] font-normal text-on-surface-variant">Private</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{key === "connectorIds" ? <ConnectorAccountStatus option={item} /> : null}</span>
                {editable ? <Button size="sm" variant="ghost" disabled={loading || saving}
                  aria-label={`Remove ${item.name}${known.has(item.id) ? "" : ` ${index + 1}`} from your defaults`}
                  onClick={() => toggle(key, item.id)}>Remove</Button> : null}
              </li>)}</ul>}
            {editable && available.length > 0 ? <ul aria-label={`Available ${label.toLowerCase()}`} className="divide-y divide-outline-variant rounded-md border border-outline-variant">{available.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <span className="min-w-0"><span className="block font-medium">{item.name} {item.source === "personal" ? <span className="ml-1 rounded-full border border-outline-variant px-1.5 py-0.5 text-[10px] font-normal text-on-surface-variant">Private</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{key === "connectorIds" ? <ConnectorAccountStatus option={item} /> : null}</span>
              <Button size="sm" variant="outline" disabled={loading || saving} aria-label={`Add ${item.name} to your defaults`} onClick={() => toggle(key, item.id)}>Add</Button>
            </li>)}</ul> : null}
            {editable && available.length === 0 && search ? <p className="text-sm text-on-surface-variant">No matches in the available library.</p> : null}
          </div>;
        })}
        {editable ? <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => setDraft(null)}>Reset to inherited defaults</Button> : null}
      </> : <div className="space-y-4">
        {([["Skills", data.skills], ["Connections", data.connectors]] as const).map(([label, items]) =>
          <div key={label} className="space-y-2"><h3 className="text-sm font-semibold">{label}</h3>
            {items.length ? <ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">
              {items.map((item) => <li key={item.id} className="p-3 text-sm"><span className="block font-medium">{item.name} {item.source === "personal" ? <span className="ml-1 rounded-full border border-outline-variant px-1.5 py-0.5 text-[10px] font-normal text-on-surface-variant">Private</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{label === "Connections" ? <ConnectorAccountStatus option={item} /> : null}</li>)}
            </ul> : <p className="text-sm text-on-surface-variant">No {label.toLowerCase()} in your inherited defaults.</p>}
          </div>)}
      </div>}
      {editable && dirty ? <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
        <span className="text-sm text-on-surface-variant">Unsaved changes</span>
        <Button size="sm" disabled={loading || saving || (conflict && Boolean(error)) || conflictDetails !== null} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
        <Button size="sm" variant="outline" disabled={loading || saving} onClick={() => {
          setDraft(data.selection); setSearch(""); setConflict(false); setConflictDetails(null); setError(null);
        }}>Cancel</Button>
      </div> : null}
      {conflictDetails && dirty ? <CapabilityConflictNotice conflict={conflictDetails} disabled={loading || saving} onKeep={() => setConflictDetails(null)} /> : null}
      {conflict && dirty && !error && !conflictDetails ? <p role="status" className="text-sm text-on-surface-variant">Your defaults changed while you were editing. The current settings are loaded and your choices are still here. Review them, then save again.</p> : null}
    </div> : null}
  </section>;
}
