"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import type { SessionCapabilities, SessionCapabilitySelection } from "@cogniplane/shared-types";
import { getSessionCapabilities, updateSessionCapabilities } from "../lib/session-api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { ConnectorAccountStatus } from "./connector-account-status";

export function SessionCapabilitiesButton({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="icon-sm" aria-label="Session capabilities" title="Session capabilities" onClick={() => setOpen(true)}>
      <SlidersHorizontalIcon />
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Session capabilities</DialogTitle>
          <DialogDescription>Choose a smaller set of skills and connections for this session. Organization policy always applies.</DialogDescription>
        </DialogHeader>
        {open ? <CapabilitiesForm key={sessionId} sessionId={sessionId} busy={busy} onClose={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

function CapabilitiesForm({ sessionId, busy, onClose }: { sessionId: string; busy: boolean; onClose: () => void }) {
  const [data, setData] = useState<SessionCapabilities | null>(null);
  const [selection, setSelection] = useState<SessionCapabilitySelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getSessionCapabilities(sessionId).then((result) => {
      if (cancelled) return;
      setData(result);
      setSelection(result.selection);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not load capabilities.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, reload]);
  const locked = busy || data?.canEdit === false;
  const defaultsLabel = data?.defaultsSource === "project" ? "project" : data?.defaultsSource === "personal" ? "personal" : "organization";
  const disabled = locked || saving || loading;
  const retry = () => { setLoading(true); setError(null); setReload((n) => n + 1); };
  const toggle = (key: keyof SessionCapabilitySelection, id: string, checked: boolean) => {
    setSelection((current) => {
      if (!current) return current;
      return { ...current, [key]: checked ? [...current[key], id] : current[key].filter((value) => value !== id) };
    });
  };
  const save = async () => {
    if (!data || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await updateSessionCapabilities(sessionId, { selection, version: data.version });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save capabilities.");
    } finally { setSaving(false); }
  };
  return <>
    {loading ? <p role="status" className="text-sm text-on-surface-variant">Loading capabilities…</p> : null}
    {error ? <div role="alert" className="space-y-2 text-sm text-danger">
      <p>{error}</p><Button variant="outline" size="sm" disabled={saving || loading} onClick={retry}>Reload capabilities</Button>
    </div> : null}
    {data ? <div className="space-y-5">
      {locked ? <p className="text-sm text-on-surface-variant">Capabilities are currently read-only for this session.</p> : null}
      <fieldset disabled={disabled} className="space-y-2 text-sm">
        <legend className="sr-only">Capability selection</legend>
        <label className="flex items-center gap-2"><input type="radio" name="capability-mode" checked={selection === null} onChange={() => setSelection(null)} />Use {defaultsLabel} defaults</label>
        <label className="flex items-center gap-2"><input type="radio" name="capability-mode" checked={selection !== null} onChange={() => setSelection({ skillIds: data.skills.map((s) => s.id), connectorIds: data.connectors.map((c) => c.id) })} />Choose for this session</label>
      </fieldset>
      <p className="text-xs text-on-surface-variant">{data.defaultsSource === "personal"
        ? selection === null
          ? "This session follows your personal defaults. If you inherit organization defaults, new approved resources appear automatically."
          : "Only selected resources from your personal defaults can be used. New defaults stay off until you select them."
        : selection === null
          ? `New resources added to the ${defaultsLabel} defaults become available automatically.`
          : `Only selected resources from the ${defaultsLabel} defaults can be used. New defaults stay off until you select them.`} Changes apply to the next turn.</p>
      {data.defaultsSource === "personal" ? <Link href="/settings/capabilities" className="text-xs font-medium text-on-surface underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">Edit personal defaults</Link> : null}
      {([
        ["Skills", "skillIds", data.skills], ["Connectors", "connectorIds", data.connectors]
      ] as const).map(([title, key, options]) => <fieldset key={key} disabled={disabled || selection === null} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{title} <span className="font-normal text-on-surface-variant">{selection === null ? options.length : selection[key].filter((id) => options.some((option) => option.id === id)).length}/{options.length}</span></legend>
        {selection?.[key].filter((id) => !options.some((option) => option.id === id)).map((id, index) => <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-outline-variant p-3 text-sm text-on-surface-variant">
          <span>Unavailable selected {title === "Skills" ? "skill" : "connection"}. It cannot be used in this session.</span>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove unavailable ${title === "Skills" ? "skill" : "connection"} ${index + 1} from this session`} onClick={() => toggle(key, id, false)}>Remove</Button>
        </div>)}
        {options.length === 0 ? <p className="text-sm text-on-surface-variant">No {title.toLowerCase()} are available in the {defaultsLabel} defaults.</p> : options.map((option) => <label key={option.id} className="flex items-start gap-3 rounded-md border border-outline-variant p-3">
          <input type="checkbox" className="mt-1 size-4 shrink-0 accent-brand" checked={selection === null || selection[key].includes(option.id)} onChange={(event) => toggle(key, option.id, event.target.checked)} />
          <span className="min-w-0 text-sm"><span className="block font-medium">{option.name} {option.source === "personal" || option.source === "project" ? <span className="ml-1 rounded-full border border-outline-variant px-1.5 py-0.5 text-[10px] font-normal text-on-surface-variant">{option.source === "personal" ? "Private" : "Project"}</span> : null}</span><span className="block break-words text-xs text-on-surface-variant">{option.description}</span>{key === "connectorIds" ? <ConnectorAccountStatus option={option} /> : null}</span>
        </label>)}
      </fieldset>)}
    </div> : null}
    <DialogFooter>
      <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button onClick={save} disabled={!data || disabled}>{saving ? "Saving…" : "Save capabilities"}</Button>
    </DialogFooter>
  </>;
}
