"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [readFailed, setReadFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [, setFocusRevision] = useState(0);
  const conflictRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const reloadPageRef = useRef<HTMLButtonElement>(null);
  const selectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const conflictBefore = useRef<PersonalCapabilities | null>(null);
  const pendingFocus = useRef<{ target: () => HTMLElement | null; origin?: Element | null } | null>(null);
  const focusAfter = useCallback((target: () => HTMLElement | null, origin?: Element | null) => { pendingFocus.current = { target, origin }; }, []);
  useLayoutEffect(() => {
    const intent = pendingFocus.current;
    if (!intent) return;
    const target = intent.target();
    if (!target) return;
    pendingFocus.current = null;
    if (intent.origin && document.activeElement !== intent.origin && document.activeElement !== document.body) return;
    target.focus();
  });
  const { tenantId, userId } = expectedScope;
  const acceptScope = useCallback((result: PersonalCapabilities) => {
    if (result.scope.tenantId === tenantId && result.scope.userId === userId) return true;
    setScopeMismatch(true);
    setData(null);
    setDraft(null);
    setError(null);
    setConflictDetails(null);
    conflictBefore.current = null;
    setSearch("");
    setSaved(false);
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
      if (active) { setReadFailed(true); setError(cause instanceof Error ? cause.message : "Could not load your defaults."); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [acceptScope]);

  const reload = async (keepDraft = false, before = conflictBefore.current): Promise<PersonalCapabilities | null> => {
    if (scopeMismatch) return null;
    setLoading(true);
    try {
      const result = await getPersonalCapabilities();
      if (!acceptScope(result)) return null;
      setData(result);
      setReadFailed(false);
      setError(null);
      if (!keepDraft) { setDraft(result.selection); setConflictDetails(null); setConflict(false); }
      else if (before) {
        setConflictDetails(capabilityConflict(before, result, draft));
        setConflict(true);
      }
      return result;
    } catch (cause) {
      setReadFailed(true);
      setError(cause instanceof Error ? cause.message : "Could not load your defaults.");
      return null;
    } finally { setLoading(false); }
  };

  const editable = data?.canEdit === true && !scopeMismatch;
  const dirty = Boolean(data && !sameSelection(data.selection, draft));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const toggle = (key: CatalogKey, id: string) => {
    setSaved(false);
    if (!conflictDetails && !readFailed) setConflict(false);
    const adding = !draft?.[key].includes(id);
    focusAfter(() => selectionButtons.current.get(`${key}:${id}:${adding ? "remove" : "add"}`) ?? searchRef.current);
    if (!draft) return;
    const next = { ...draft, [key]: adding ? [...draft[key], id] : draft[key].filter((value) => value !== id) };
    setDraft(next);
    if (conflictDetails && conflictBefore.current && data) setConflictDetails(capabilityConflict(conflictBefore.current, data, next));
  };
  const save = async () => {
    if (!data || !editable || !dirty || saving || loading || scopeMismatch || readFailed || conflictDetails) return;
    const origin = document.activeElement;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await updatePersonalCapabilities({ selection: draft, version: data.version, scope: data.scope });
      if (!acceptScope(result)) { focusAfter(() => reloadPageRef.current, origin); return; }
      setData(result);
      setDraft(result.selection);
      setSearch("");
      setConflict(false);
      setConflictDetails(null);
      conflictBefore.current = null;
      setSaved(true);
      focusAfter(() => feedbackRef.current, origin);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your defaults.");
      if (cause instanceof ApiError && cause.code === "capabilities_scope_changed") {
        setScopeMismatch(true);
        setData(null);
        setDraft(null);
        setConflictDetails(null);
        conflictBefore.current = null;
        focusAfter(() => reloadPageRef.current, origin);
      } else if (cause instanceof ApiError && cause.status === 409) {
        conflictBefore.current = data;
        const reloaded = await reload(true, data);
        setConflict(true);
        setConflictDetails(reloaded ? capabilityConflict(data, reloaded, draft) : null);
        if (!reloaded) setError("Your defaults changed, but their current values could not be loaded. Reload before saving.");
        focusAfter(() => reloadPageRef.current ?? (reloaded ? conflictRef.current ?? summaryRef.current : errorRef.current), origin);
      } else if (cause instanceof ApiError && cause.status === 403) {
        setData((current) => current && { ...current, canEdit: false });
        await reload(true);
        focusAfter(() => reloadPageRef.current ?? summaryRef.current, origin);
      } else { focusAfter(() => errorRef.current, origin); }
    } finally { setSaving(false); }
  };

  return <section aria-labelledby="personal-capabilities-title" className="min-w-0 space-y-5 pt-5">
    <div className="max-w-2xl space-y-2 text-sm text-on-surface-variant">
      <h2 id="personal-capabilities-title" className="font-headline text-base font-semibold text-on-surface">Your chat defaults</h2>
      <p>Choose the organization skills, your available private skills, and approved connections for your standalone chats. Changes apply on the next turn.</p>
      <p>Projects and scheduled jobs use their own settings. To connect an account or approve a connection, visit <Link href="/settings/connections" className="font-medium text-on-surface underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">Connected accounts</Link>.</p>
    </div>
    {loading && !data ? <div role="status" aria-label="Loading personal capabilities" className="space-y-2 text-sm text-on-surface-variant"><p>Loading your chat defaults...</p><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}
    {scopeMismatch ? <div role="alert" className="space-y-2 text-sm text-danger">
      <p>Your account or organization changed. Reload this page before editing these defaults.</p>
      <Button ref={reloadPageRef} size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
    </div> : null}
    {error && !scopeMismatch ? <div ref={errorRef} tabIndex={-1} role="alert" className="space-y-2 break-words text-sm text-danger focus-visible:outline-2 focus-visible:outline-primary"><p>{error}</p>
      <Button size="sm" variant="outline" aria-disabled={loading || saving || undefined} className="aria-disabled:opacity-50" onClick={async () => {
        if (loading || saving) return;
        const origin = document.activeElement;
        const result = await reload(dirty);
        focusAfter(() => reloadPageRef.current ?? (!result ? errorRef.current : conflictRef.current ?? (draft !== null && result.canEdit ? searchRef.current : summaryRef.current)), origin);
        setFocusRevision((current) => current + 1);
      }}>Reload defaults</Button>
    </div> : null}
    {data ? <div className="min-w-0 space-y-6 border-t border-outline-variant pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl space-y-1">
          <p ref={summaryRef} tabIndex={-1} className="font-headline text-base font-semibold focus-visible:outline-2 focus-visible:outline-primary">{draft === null ? "Using inherited defaults" : "Custom selection"}</p>
          <p className="text-sm text-on-surface-variant">{draft === null
            ? "Organization defaults and your available private skills appear here automatically."
            : "Only selected resources are included. New organization or private skills stay out until you add them."}</p>
        </div>
        {editable && draft === null ? <Button size="sm" variant="outline" disabled={loading || saving} onClick={() => {
          setSaved(false);
          setDraft({ skillIds: data.skills.map((item) => item.id), connectorIds: data.connectors.map((item) => item.id) });
          focusAfter(() => searchRef.current);
        }}>Customize</Button> : null}
      </div>
      {loading ? <p role="status" className="text-sm text-on-surface-variant">Refreshing defaults. {dirty ? "Your unsaved choices stay here." : "Editing is paused until the current defaults load."}</p> : null}
      {readFailed ? <p className="text-sm text-on-surface-variant">The latest defaults could not be checked. {dirty ? "Your unsaved choices stay here. " : ""}Reload defaults before saving.</p> : null}
      {!editable ? <p role="status" className="text-sm text-on-surface-variant">Your defaults are read-only right now.{dirty ? " Your unsaved choices stay here and have not been saved." : ""}</p> : null}
      {draft !== null && editable ? <div className="max-w-md space-y-1">
        <label htmlFor="personal-capabilities-search" className="text-sm font-medium">Add skills or connections</label>
        <Input ref={searchRef} id="personal-capabilities-search" type="search" value={search}
          aria-describedby="personal-capabilities-search-hint" onChange={(event) => setSearch(event.target.value)} placeholder="Search available resources" disabled={loading || saving} />
        <p id="personal-capabilities-search-hint" className="text-xs text-on-surface-variant">Search available resources. Your selected list stays visible.</p>
      </div> : null}
      {(["skillIds", "connectorIds"] as const).map((key) => {
        const catalog = key === "skillIds" ? data.skills : data.connectors;
        const label = key === "skillIds" ? "Skills" : "Connections";
        const known = new Map(catalog.map((item) => [item.id, item]));
        const selected = draft === null ? catalog : draft[key].map((id) => known.get(id) ?? {
          id, name: "Unavailable resource", description: "This selection is no longer in the available library."
        });
        const available = draft === null ? [] : catalog.filter((item) => !draft[key].includes(item.id) &&
          `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        const renderItem = (item: typeof selected[number], index: number, action?: "add" | "remove") => <li key={item.id} className="flex min-w-0 flex-col items-start gap-3 py-3 text-sm sm:flex-row sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1 [overflow-wrap:anywhere]">
            <p className="font-medium">{item.name} {"source" in item && item.source === "personal" ? <span className="ml-1 inline-block rounded border border-outline-variant px-1.5 py-0.5 align-middle text-xs font-normal text-on-surface-variant">Private</span> : null}</p>
            <p className="text-sm text-on-surface-variant">{item.description}</p>
            {!known.has(item.id) ? <p className="text-xs text-on-surface-variant">Saved reference: {item.id}. Kept until you remove it.</p> : null}
            {key === "connectorIds" ? <ConnectorAccountStatus option={item} /> : null}
          </div>
          {action && editable ? <Button ref={(node) => {
            const name = `${key}:${item.id}:${action}`;
            if (node) selectionButtons.current.set(name, node); else selectionButtons.current.delete(name);
          }} size="sm" variant={action === "add" ? "outline" : "ghost"} className="shrink-0 max-sm:min-h-10" disabled={loading || saving}
            aria-label={`${action === "add" ? "Add" : "Remove"} ${item.name}${known.has(item.id) ? "" : ` ${index + 1}`} ${action === "add" ? "to" : "from"} your defaults`}
            onClick={() => toggle(key, item.id)}>{action === "add" ? "Add" : "Remove"}</Button> : null}
        </li>;
        return <div key={key} className="min-w-0 space-y-2">
          <h3 className="font-headline text-base font-semibold">{label}</h3>
          {draft !== null ? <p className="text-xs font-medium text-on-surface-variant">Selected {label.toLowerCase()} ({selected.length})</p> : null}
          {selected.length === 0 ? <p className="text-sm text-on-surface-variant">{draft === null ? `No ${label.toLowerCase()} in your inherited defaults.` : `No ${label.toLowerCase()} selected.`}</p> :
            <ul aria-label={`${draft === null ? "Inherited" : "Selected"} ${label.toLowerCase()}`} className="divide-y divide-outline-variant border-y border-outline-variant">{selected.map((item, index) => renderItem(item, index, draft === null ? undefined : "remove"))}</ul>}
          {draft !== null && editable ? <div className="space-y-1 pt-2">
            <h4 className="text-sm font-medium">Available {label.toLowerCase()} ({available.length})</h4>
            {available.length > 0 ? <ul aria-label={`Available ${label.toLowerCase()}`} className="divide-y divide-outline-variant border-y border-outline-variant">{available.map((item, index) => renderItem(item, index, "add"))}</ul> :
              <p className="text-sm text-on-surface-variant">{search ? "No matches in the available library." : `All available ${label.toLowerCase()} are selected.`}</p>}
          </div> : null}
        </div>;
      })}
      {draft !== null && editable ? <div className="space-y-1 border-t border-outline-variant pt-4">
        <Button size="sm" variant="outline" className="h-auto min-h-10 whitespace-normal text-left" disabled={loading || saving} onClick={() => {
          setDraft(null); setSearch(""); setSaved(false);
          if (conflictDetails && conflictBefore.current) setConflictDetails(capabilityConflict(conflictBefore.current, data, null));
          focusAfter(() => summaryRef.current);
        }}>Reset to inherited defaults</Button>
        <p className="text-xs text-on-surface-variant">Review the inherited list, then save to apply this change.</p>
      </div> : null}
      {conflictDetails && dirty ? <div ref={conflictRef} tabIndex={-1} aria-label="Defaults changed while editing" className="[overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-primary"><CapabilityConflictNotice conflict={conflictDetails} disabled={loading || saving} onKeep={() => {
        setConflictDetails(null); focusAfter(() => saveRef.current);
      }} /></div> : null}
      {conflict && dirty && !error && !conflictDetails ? <p role="status" className="text-sm text-on-surface-variant">Your defaults changed while you were editing. The current settings are loaded and your choices are still here. Review them, then save again.</p> : null}
      {editable && dirty ? <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
        <p role="status" className="basis-full text-sm text-on-surface-variant">{saving ? "Saving your defaults..." : "Unsaved changes"}</p>
        <Button ref={saveRef} size="sm" className="min-h-10 aria-disabled:opacity-50" aria-disabled={saving || undefined} disabled={loading || readFailed || conflictDetails !== null} onClick={() => void save()}>{saving ? "Saving..." : "Save changes"}</Button>
        <Button size="sm" variant="outline" className="min-h-10" disabled={loading || saving} onClick={() => {
          setDraft(data.selection); setSearch(""); setConflict(false); setConflictDetails(null); setSaved(false); conflictBefore.current = null;
          if (!readFailed) setError(null);
          focusAfter(() => summaryRef.current);
        }}>Cancel</Button>
      </div> : null}
      {saved && !dirty ? <p ref={feedbackRef} tabIndex={-1} role="status" className="text-sm text-on-surface-variant focus-visible:outline-2 focus-visible:outline-primary">Your chat defaults are saved.</p> : null}
    </div> : null}
  </section>;
}
