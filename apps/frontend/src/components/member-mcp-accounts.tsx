"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { McpConnection, MemberMcpCredentialSave } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { getMemberMcpConnections, removeMemberMcpCredentials, saveMemberMcpCredentials } from "@/lib/member-mcp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type Scope = MemberMcpCredentialSave["scope"];
type Draft = { serverId: string; secret: string; accountLabel: string; initialLabel: string; reviewed: boolean };
const statusLabel: Record<McpConnection["status"], string> = {
  organization: "Organization account", no_auth: "No account needed", not_connected: "Not connected",
  connected: "Credentials saved", reconnect_required: "Reconnect required", unavailable: "Unavailable"
};
const authLabel = (connection: McpConnection) => connection.authType === "bearer" ? "Bearer token"
  : connection.authType === "header" ? `Header ${connection.authName ?? ""}`
  : connection.authType === "query" ? `Query parameter ${connection.authName ?? ""}` : "No authentication";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Try again.";

export function MemberMcpAccounts({ expectedScope }: { expectedScope: Scope }) {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockReason, setLockReason] = useState<"scope" | "session" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const selected = useMemo(() => connections.find((item) => item.serverId === draft?.serverId) ?? null, [connections, draft?.serverId]);
  const dirty = Boolean(draft && (draft.secret || draft.accountLabel !== draft.initialLabel));
  const locked = lockReason !== null;
  const disabled = loading || busy || locked;
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    (actionRefs.current.get(id) ?? headingRef.current)?.focus();
  }, [draft, connections]);
  const lock = useCallback((reason: "scope" | "session") => {
    setLockReason(reason); setConnections([]); setDraft(null); setConfirmRemove(null); setError(null);
  }, []);
  const checkScope = useCallback((scope: Scope) => {
    if (scope.tenantId === expectedScope.tenantId && scope.userId === expectedScope.userId) return true;
    lock("scope"); return false;
  }, [expectedScope.tenantId, expectedScope.userId, lock]);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.code === "member_mcp_scope_changed")) {
      lock(cause.status === 401 ? "session" : "scope"); return;
    }
    setError(errorText(cause));
  }, [lock]);
  const reload = useCallback(async () => {
    if (locked) return null;
    setDraft((current) => current && { ...current, secret: "", reviewed: false });
    setLoading(true);
    try {
      const result = await getMemberMcpConnections();
      if (!checkScope(result.scope)) return null;
      setConnections(result.connections); setError(null);
      return result.connections;
    } catch (cause) { handleError(cause); return null; }
    finally { setLoading(false); }
  }, [checkScope, handleError, locked]);
  useEffect(() => {
    let active = true;
    getMemberMcpConnections().then((result) => {
      if (!active || !checkScope(result.scope)) return;
      setConnections(result.connections);
    }).catch((cause: unknown) => { if (active) handleError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [checkScope, handleError]);
  const open = (connection: McpConnection) => {
    if (dirty && !window.confirm("Discard the credential you entered?")) return;
    setDraft({ serverId: connection.serverId, secret: "", accountLabel: connection.accountLabel ?? "",
      initialLabel: connection.accountLabel ?? "", reviewed: false });
    setConfirmRemove(null); setError(null);
  };
  const cancel = () => {
    if (dirty && !window.confirm("Discard the credential you entered?")) return;
    pendingFocus.current = draft?.serverId ?? null;
    setDraft(null); setError(null);
  };
  const save = async () => {
    if (!selected || !draft || !draft.reviewed || draft.secret.length < 8 || !selected.canConnect || disabled) return;
    setBusy(true); setError(null);
    try {
      const result = await saveMemberMcpCredentials(selected.serverId, {
        scope: expectedScope, version: selected.credentialVersion, serverVersion: selected.serverVersion,
        secret: draft.secret, accountLabel: draft.accountLabel.trim() || null
      });
      if (!checkScope(result.scope)) return;
      pendingFocus.current = selected.serverId;
      setConnections((current) => current.map((item) => item.serverId === selected.serverId ? result.connection : item));
      setDraft(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "member_mcp_conflict" && cause.status === 409) {
        setDraft((current) => current && { ...current, secret: "", reviewed: false });
        const fresh = await reload();
        if (fresh) setError(`${errorText(cause)} Review the current endpoint and authentication before entering a new credential.`);
      } else if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        setDraft((current) => current && { ...current, secret: "", reviewed: false });
        await reload();
        setError(errorText(cause));
      } else handleError(cause);
    } finally { setBusy(false); }
  };
  const remove = async (connection: McpConnection) => {
    if (disabled || confirmRemove !== connection.serverId) return;
    setBusy(true); setError(null);
    try {
      const result = await removeMemberMcpCredentials(connection.serverId, { scope: expectedScope, version: connection.credentialVersion });
      if (!checkScope(result.scope)) return;
      setConfirmRemove(null); setDraft(null);
      await reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "member_mcp_conflict" && cause.status === 409) {
        setDraft(null); setConfirmRemove(null);
        const fresh = await reload();
        if (fresh) setError(`${errorText(cause)} Review the current connection before removing credentials.`);
      } else handleError(cause);
    } finally { setBusy(false); }
  };

  return <section aria-labelledby="member-mcp-title" className="mt-8 space-y-4 border-t border-outline-variant pt-6">
    <div><h2 ref={headingRef} tabIndex={-1} id="member-mcp-title" className="text-base font-semibold">Organization MCP connections</h2>
      <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">Your organization approves these connections. For connections that require your account, save a secret for your own use. Saving it does not verify your provider identity.</p></div>
    {locked ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{lockReason === "session" ? "Your session expired. Sign in again, then reload this page before managing credentials." : "Your account or organization changed. Reload this page before managing credentials."}</p><Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button></div> : null}
    {error && !locked ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{error}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => void reload()}>Reload connections</Button></div> : null}
    {loading && connections.length === 0 && !locked ? <div aria-label="Loading MCP connections" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : null}
    {!loading && !locked && connections.length === 0 ? <p className="rounded-lg border border-outline-variant p-5 text-sm text-on-surface-variant">No organization MCP connections are available to you.</p> : null}
    {!locked && connections.length > 0 ? <ul className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">{connections.map((connection) => <li key={connection.serverId} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{connection.serverName}</h3><span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">{statusLabel[connection.status]}</span></div>{connection.description ? <p className="break-words text-sm text-on-surface-variant">{connection.description}</p> : null}{connection.accountLabel ? <p className="text-xs text-on-surface-variant">Account label: {connection.accountLabel} (entered by you)</p> : null}</div>
        <div className="flex flex-wrap gap-2">{connection.credentialScope === "personal" && connection.canConnect ? <Button ref={(node) => { if (node) actionRefs.current.set(connection.serverId, node); else actionRefs.current.delete(connection.serverId); }} size="sm" variant="outline" disabled={disabled} onClick={() => open(connection)}>{connection.status === "connected" ? "Replace secret" : connection.status === "reconnect_required" ? "Reconnect" : "Connect"}</Button> : null}{connection.hasCredential ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { if (dirty && !window.confirm("Discard the credential you entered?")) return; setDraft(null); setConfirmRemove(connection.serverId); setError(null); }}>Remove credentials</Button> : null}</div>
      </div>
      {draft?.serverId === connection.serverId && selected && !locked ? <div className="space-y-4 rounded-md border border-outline-variant bg-surface p-4"><h4 className="font-medium">{connection.status === "connected" ? "Replace your credential" : "Connect your account"}</h4>
        <div className="space-y-1 text-sm"><p><span className="font-medium">Endpoint:</span> <span className="break-all">{connection.upstreamUrl ?? "Unavailable"}</span></p><p><span className="font-medium">Authentication:</span> {authLabel(connection)}</p></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.reviewed} disabled={disabled} onChange={(event) => setDraft((current) => current && { ...current, reviewed: event.target.checked })} /><span>I reviewed this endpoint and authentication method.</span></label>
        {draft.reviewed ? <div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="member-mcp-secret" className="text-sm font-medium">Secret</label><Input id="member-mcp-secret" className="mt-1" type="password" autoComplete="new-password" minLength={8} maxLength={8192} value={draft.secret} disabled={disabled} onChange={(event) => setDraft((current) => current && { ...current, secret: event.target.value })} /><p className="mt-1 text-xs text-on-surface-variant">Use at least 8 characters.</p></div><div><label htmlFor="member-mcp-label" className="text-sm font-medium">Account label (optional)</label><Input id="member-mcp-label" className="mt-1" maxLength={120} value={draft.accountLabel} disabled={disabled} onChange={(event) => setDraft((current) => current && { ...current, accountLabel: event.target.value })} /></div></div> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || !draft.reviewed || draft.secret.length < 8} onClick={() => void save()}>{busy ? "Saving…" : "Save credentials"}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={cancel}>Cancel</Button></div>
      </div> : null}
      {confirmRemove === connection.serverId ? <div role="group" aria-label={`Confirm removal for ${connection.serverName}`} className="flex flex-wrap items-center gap-2 rounded-md border border-outline-variant p-3 text-sm"><span>Remove your saved credential for {connection.serverName}?</span><Button size="sm" variant="destructive" disabled={disabled} onClick={() => void remove(connection)}>Remove now</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmRemove(null)}>Keep credential</Button></div> : null}
    </li>)}</ul> : null}
  </section>;
}
