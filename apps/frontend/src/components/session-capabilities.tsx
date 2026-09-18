"use client";

import { useEffect, useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import type { SessionCapabilities, SessionCapabilitySelection } from "@cogniplane/shared-types";
import { getSessionCapabilities, updateSessionCapabilities } from "../lib/session-api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

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
          <DialogDescription>Choose the skills and connectors available to this session. Organization policy always applies.</DialogDescription>
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
      setSelection(result.selection ? {
        skillIds: result.selection.skillIds.filter((id) => result.skills.some((s) => s.id === id)),
        connectorIds: result.selection.connectorIds.filter((id) => result.connectors.some((c) => c.id === id))
      } : null);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not load capabilities.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, reload]);
  const locked = busy || data?.canEdit === false;
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
        <label className="flex items-center gap-2"><input type="radio" name="capability-mode" checked={selection === null} onChange={() => setSelection(null)} />Use organization defaults</label>
        <label className="flex items-center gap-2"><input type="radio" name="capability-mode" checked={selection !== null} onChange={() => setSelection({ skillIds: data.skills.map((s) => s.id), connectorIds: data.connectors.map((c) => c.id) })} />Choose for this session</label>
      </fieldset>
      <p className="text-xs text-on-surface-variant">{selection === null ? "New capabilities enabled by your organization become available automatically." : "Only selected capabilities will be available. New organization capabilities stay off until you select them."} Changes apply to the next turn.</p>
      {([
        ["Skills", "skillIds", data.skills], ["Connectors", "connectorIds", data.connectors]
      ] as const).map(([title, key, options]) => <fieldset key={key} disabled={disabled || selection === null} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{title} <span className="font-normal text-on-surface-variant">{selection === null ? options.length : selection[key].length}/{options.length}</span></legend>
        {options.length === 0 ? <p className="text-sm text-on-surface-variant">No {title.toLowerCase()} are available under organization policy.</p> : options.map((option) => <label key={option.id} className="flex items-start gap-3 rounded-md border border-outline-variant p-3">
          <input type="checkbox" className="mt-1 size-4 shrink-0 accent-brand" checked={selection === null || selection[key].includes(option.id)} onChange={(event) => toggle(key, option.id, event.target.checked)} />
          <span className="min-w-0 text-sm"><span className="block font-medium">{option.name}</span><span className="block break-words text-xs text-on-surface-variant">{option.description}</span></span>
        </label>)}
      </fieldset>)}
    </div> : null}
    <DialogFooter>
      <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button onClick={save} disabled={!data || disabled}>{saving ? "Saving…" : "Save capabilities"}</Button>
    </DialogFooter>
  </>;
}
