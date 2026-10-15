"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectCapabilities, SessionCapabilitySelection } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { getProjectCapabilities, updateProjectCapabilities } from "@/lib/project-api";
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

export function ProjectCapabilities({ projectId, archived, canManage, refreshRevision = 0, onAccessFailure }: {
  projectId: string; archived: boolean; canManage: boolean; refreshRevision?: number; onAccessFailure?: () => Promise<unknown>
}) {
  const [data, setData] = useState<ProjectCapabilities | null>(null);
  const [draft, setDraft] = useState<SessionCapabilitySelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessFailure, setAccessFailure] = useState(false);
  const [conflict, setConflict] = useState(false);
  // Differences found after a 409. Save stays blocked until the user keeps their changes.
  const [conflictDetails, setConflictDetails] = useState<CapabilityConflict | null>(null);
  const [selectionChanged, setSelectionChanged] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    getProjectCapabilities(projectId).then((result) => {
      if (!active) return;
      setData(result);
      setDraft(result.selection);
      setError(null);
      setConflict(false);
      setSelectionChanged(false);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load project capabilities.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  const reload = useCallback(async (keepDraft = false): Promise<ProjectCapabilities | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await getProjectCapabilities(projectId);
      const hasUnsavedChoices = keepDraft && data !== null && !sameSelection(data.selection, draft);
      setSelectionChanged(hasUnsavedChoices && !sameSelection(data.selection, result.selection));
      setData(result);
      if (!hasUnsavedChoices) { setDraft(result.selection); setConflictDetails(null); }
      setConflict(false);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load project capabilities.");
      return null;
    } finally { setLoading(false); }
  }, [projectId, data, draft]);
  const previousAccess = useRef({ projectId, canManage, archived });
  const previousRevision = useRef(refreshRevision);
  useEffect(() => {
    if (previousRevision.current === refreshRevision) return;
    previousRevision.current = refreshRevision;
    let cancelled = false;
    if (data) void Promise.resolve().then(() => { if (!cancelled) void reload(true); });
    return () => { cancelled = true; };
  }, [refreshRevision, data, reload]);
  useEffect(() => {
    const previous = previousAccess.current;
    previousAccess.current = { projectId, canManage, archived };
    if (previous.canManage !== canManage || previous.archived !== archived) setAccessFailure(false);
    if (data && previous.projectId === projectId &&
      (previous.canManage !== canManage || previous.archived !== archived)) void reload(true);
  }, [projectId, canManage, archived, data, reload]);
  const editable = Boolean(data?.canEdit) && canManage && !archived;
  const dirty = Boolean(data && !sameSelection(data.selection, draft));
  const toggle = (key: CatalogKey, id: string) => {
    setConflict(false);
    setDraft((current) => current && ({ ...current,
      [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id]
    }));
  };
  const save = async () => {
    if (!data || !editable || !dirty || saving || loading || (conflict && error) || conflictDetails) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateProjectCapabilities(projectId, { selection: draft, version: data.version });
      setData(result);
      setDraft(result.selection);
      setSearch("");
      setAccessFailure(false);
      setSelectionChanged(false);
      setConflictDetails(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save project capabilities.");
      if (cause instanceof ApiError && cause.status === 409 && cause.code !== "project_archived") {
        const reloaded = await reload(true);
        setConflict(true);
        setConflictDetails(reloaded ? capabilityConflict(data, reloaded, draft) : null);
        if (!reloaded) setError("The project changed, but its current settings could not be loaded. Reload before saving.");
      } else if (cause instanceof ApiError && (cause.status === 403 || cause.code === "project_archived")) {
        setAccessFailure(true);
        setData((current) => current && { ...current, canEdit: false });
        await Promise.allSettled([reload(true), onAccessFailure?.()]);
      }
    } finally { setSaving(false); }
  };

  return <section aria-labelledby="project-capabilities-title" className="rounded-lg border border-outline-variant bg-surface-container-low p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="project-capabilities-title" className="font-semibold">Skills &amp; connections</h3>
        <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">Choose which skills and connections project sessions can use. Each member connects their own account where required. Project selection does not share personal credentials.</p>
      </div>
      {data && editable && draft === null ? <Button size="sm" variant="outline" onClick={() => {
        setDraft({ skillIds: data.skills.map((item) => item.id), connectorIds: data.connectors.map((item) => item.id) });
      }} disabled={saving || loading}>Customize</Button> : null}
    </div>
    {loading && !data ? <div aria-label="Loading project capabilities" className="mt-4 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}
    {error ? <div role="alert" className="mt-4 text-sm text-danger"><p>{error}</p>
      <Button size="sm" variant="outline" className="mt-2" disabled={saving || loading} onClick={() => void reload(dirty)}>Reload capabilities</Button>
    </div> : null}
    {data ? <div className="mt-4 space-y-5">
      <p className="text-sm font-medium">{draft === null ? "Using organization defaults" : "Custom project selection"}</p>
      <p className="max-w-2xl text-sm text-on-surface-variant">{draft === null
        ? "New organization defaults and released project skills appear in this project automatically."
        : "Only selected resources are included. New organization resources stay out until an owner adds them. Releasing a project skill adds it to this selection."}</p>
      {!editable ? <div className="space-y-2 text-sm text-on-surface-variant">
        <p>{archived ? "Restore this project to change its selection." : !canManage
          ? "Only project owners can change this selection."
          : accessFailure ? "Project access or availability changed. Refresh project settings."
          : "Project settings are read-only while project work is active. Refresh when it ends."}</p>
        {canManage && !archived ? <Button size="sm" variant="outline" disabled={loading || saving} onClick={() => void reload(dirty)}>Refresh availability</Button> : null}
      </div> : null}
      {draft !== null ? <>
        {editable ? <div className="max-w-md"><label htmlFor="project-capabilities-search" className="text-sm font-medium">Add skills or connections</label>
          <Input id="project-capabilities-search" type="search" className="mt-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search skills and connections" disabled={saving || loading} /></div> : null}
        {(["skillIds", "connectorIds"] as const).map((key) => {
          const catalog = key === "skillIds" ? data.skills : data.connectors;
          const label = key === "skillIds" ? "Skills" : "Connections";
          const known = new Map(catalog.map((item) => [item.id, item]));
          const selected = draft[key].map((id) => known.get(id) ?? { id, name: "Unavailable resource", description: "This selection is no longer in the available library." });
          const available = catalog.filter((item) => !draft[key].includes(item.id) &&
            `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
          return <div key={key} className="space-y-2">
            <h4 className="text-sm font-semibold">{label}</h4>
            {selected.length === 0 ? <p className="text-sm text-on-surface-variant">No {label.toLowerCase()} selected.</p> :
              <ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">{selected.map((item, index) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span className="min-w-0"><span className="block font-medium">{item.name} {"source" in item && item.source === "project" ? <span className="text-xs font-normal text-on-surface-variant">Project</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{key === "connectorIds" ? <ConnectorAccountStatus option={item} /> : null}</span>
                {editable ? <Button size="sm" variant="ghost" disabled={saving || loading} aria-label={`Remove ${item.name}${known.has(item.id) ? "" : ` ${index + 1}`} from this project`} onClick={() => toggle(key, item.id)}>Remove</Button> : null}
              </li>)}</ul>}
            {editable && available.length > 0 ? <ul aria-label={`Available ${label.toLowerCase()}`} className="divide-y divide-outline-variant rounded-md border border-outline-variant">{available.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <span className="min-w-0"><span className="block font-medium">{item.name} {"source" in item && item.source === "project" ? <span className="text-xs font-normal text-on-surface-variant">Project</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{key === "connectorIds" ? <ConnectorAccountStatus option={item} /> : null}</span>
              <Button size="sm" variant="outline" disabled={saving || loading} aria-label={`Add ${item.name} to this project`} onClick={() => toggle(key, item.id)}>Add</Button>
            </li>)}</ul> : null}
            {editable && available.length === 0 && search ? <p className="text-sm text-on-surface-variant">No matching resources.</p> : null}
          </div>;
        })}
        {editable ? <Button size="sm" variant="ghost" disabled={saving || loading} onClick={() => setDraft(null)}>Reset to organization defaults</Button> : null}
      </> : <div className="space-y-4">
        {([ ["Skills", data.skills], ["Connections", data.connectors] ] as const).map(([label, items]) =>
          <div key={label} className="space-y-2"><h4 className="text-sm font-semibold">{label}</h4>
            {items.length ? <ul className="divide-y divide-outline-variant rounded-md border border-outline-variant">
              {items.map((item) => <li key={item.id} className="p-3 text-sm"><span className="block font-medium">{item.name} {"source" in item && item.source === "project" ? <span className="text-xs font-normal text-on-surface-variant">Project</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{item.description}</span>{label === "Connections" ? <ConnectorAccountStatus option={item} /> : null}</li>)}
            </ul> : <p className="text-sm text-on-surface-variant">No {label.toLowerCase()} in the current organization defaults.</p>}
          </div>)}
      </div>}
      {editable && dirty ? <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
        <span className="text-sm text-on-surface-variant">Unsaved changes</span>
        <Button size="sm" disabled={saving || loading || (conflict && Boolean(error)) || conflictDetails !== null} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
        <Button size="sm" variant="outline" disabled={saving || loading} onClick={() => { setDraft(data.selection); setSearch(""); setConflict(false); setConflictDetails(null); setSelectionChanged(false); setError(null); }}>Cancel</Button>
      </div> : null}
      {conflictDetails && dirty ? <CapabilityConflictNotice conflict={conflictDetails} disabled={saving || loading} onKeep={() => setConflictDetails(null)} /> : null}
      {conflict && !error && !conflictDetails ? <p role="status" className="text-sm text-on-surface-variant">The project changed while you were editing. The current settings are loaded and your choices are still here. Review them, then save again.</p> : null}
      {selectionChanged && !conflict ? <p role="status" className="text-sm text-on-surface-variant">The current selection changed while you were editing. Your unsaved choices are still here. Review them before saving.</p> : null}
      {draft !== null ? <p className="text-xs text-on-surface-variant">Removing a selection leaves the skill or connection itself unchanged.</p> : null}
    </div> : null}
  </section>;
}
