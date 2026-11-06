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
// A security change of the member's account suspended the saved credential.
// There is no confirm: the page cannot show which account the secret belongs to.
const isSuspended = (connection: McpConnection) => connection.suspended === true;
const labelOf = (connection: McpConnection) => isSuspended(connection) ? "Suspended" : statusLabel[connection.status];
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
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const removalHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const selected = useMemo(() => connections.find((item) => item.serverId === draft?.serverId) ?? null, [connections, draft?.serverId]);
  const editingServerId = draft?.serverId;
  const dirty = Boolean(draft && (draft.secret || draft.accountLabel !== draft.initialLabel));
  const locked = lockReason !== null;
  const disabled = loading || busy || locked;
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id || busy || loading) return;
    pendingFocus.current = null;
    (actionRefs.current.get(id) ?? headingRef.current)?.focus();
  }, [draft, confirmRemove, connections, busy, loading]);
  useLayoutEffect(() => {
    if (editingServerId) editorHeadingRef.current?.focus();
    else if (confirmRemove) removalHeadingRef.current?.focus();
  }, [editingServerId, confirmRemove]);
  const lock = useCallback((reason: "scope" | "session") => {
    pendingFocus.current = "section";
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
    if (!selected || !draft || !draft.reviewed || draft.secret.length < 8 || draft.secret.length > 8192 || !selected.canConnect || disabled) return;
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
      pendingFocus.current = connection.serverId;
      setConfirmRemove(null); setDraft(null);
      await reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "member_mcp_conflict" && cause.status === 409) {
        pendingFocus.current = connection.serverId;
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
    {error && !locked && (!draft || !selected) && !confirmRemove ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{error}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => void reload()}>Reload connections</Button></div> : null}
    {loading && connections.length === 0 && !locked ? <div aria-label="Loading MCP connections" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : null}
    {!loading && !locked && !error && connections.length === 0 ? <p className="rounded-lg border border-outline-variant p-5 text-sm text-on-surface-variant">No organization MCP connections are available to you.</p> : null}
    {!locked && connections.length > 0 ? <ul className="divide-y divide-outline-variant overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">{connections.map((connection) => <li key={connection.serverId} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{connection.serverName}</h3><span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">{labelOf(connection)}</span></div>{connection.description ? <p className="break-words text-sm text-on-surface-variant">{connection.description}</p> : null}{connection.accountLabel && !isSuspended(connection) ? <p className="break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">Account label: {connection.accountLabel} (entered by you)</p> : null}</div>
        <div className="flex flex-wrap gap-2">{connection.credentialScope === "personal" && connection.canConnect ? <Button ref={(node) => { if (node) actionRefs.current.set(connection.serverId, node); else actionRefs.current.delete(connection.serverId); }} size="sm" variant="outline" disabled={disabled} aria-expanded={draft?.serverId === connection.serverId} aria-controls={draft?.serverId === connection.serverId ? `member-mcp-editor-${connection.serverId}` : undefined} onClick={() => open(connection)}>{connection.status === "connected" || isSuspended(connection) ? "Replace secret" : connection.status === "reconnect_required" ? "Reconnect" : "Connect"}</Button> : null}{connection.hasCredential ? <Button ref={(node) => { const key = `${connection.serverId}:remove`; if (node) actionRefs.current.set(key, node); else actionRefs.current.delete(key); }} size="sm" variant="ghost" disabled={disabled} aria-expanded={confirmRemove === connection.serverId} aria-controls={confirmRemove === connection.serverId ? `member-mcp-remove-${connection.serverId}` : undefined} onClick={() => { if (dirty && !window.confirm("Discard the credential you entered?")) return; setDraft(null); setConfirmRemove(connection.serverId); setError(null); }}>Remove credentials</Button> : null}</div>
      </div>
      {isSuspended(connection) ? <div role="status" className="rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm"><p className="font-semibold text-on-surface">Suspended because your account security changed</p><p className="text-on-surface-variant">Your password changed or you signed out on all devices. The agent does not use this credential. Save a new secret, or remove it.</p></div> : null}
      {draft?.serverId === connection.serverId && selected && !locked ? <div id={`member-mcp-editor-${connection.serverId}`} role="group" aria-labelledby={`member-mcp-editor-title-${connection.serverId}`} className="space-y-4 border-t border-outline-variant pt-4"><h4 ref={editorHeadingRef} tabIndex={-1} id={`member-mcp-editor-title-${connection.serverId}`} className="rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">{connection.status === "connected" || isSuspended(connection) ? "Replace your credential" : "Connect your account"}</h4>
        {error ? <div role="alert" className="space-y-2 text-sm text-danger"><p className="break-words">{error}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => void reload()}>Reload connections</Button></div> : null}
        <div className="space-y-1 text-sm"><p><span className="font-medium">Endpoint:</span> <span className="break-all">{connection.upstreamUrl ?? "Unavailable"}</span></p><p><span className="font-medium">Authentication:</span> {authLabel(connection)}</p></div>
        {!selected.canConnect ? <p role="status" className="text-sm text-on-surface-variant">This connection is no longer available for new credentials. Ask an administrator to check Admin &gt; Connections.</p> : null}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={draft.reviewed} disabled={disabled || !selected.canConnect} onChange={(event) => setDraft((current) => current && { ...current, reviewed: event.target.checked })} /><span>I reviewed this endpoint and authentication method.</span></label>
        {draft.reviewed ? <div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="member-mcp-secret" className="text-sm font-medium">Secret</label><Input id="member-mcp-secret" className="mt-1" type="password" autoComplete="new-password" minLength={8} maxLength={8192} value={draft.secret} disabled={disabled || !selected.canConnect} onChange={(event) => setDraft((current) => current && { ...current, secret: event.target.value })} /><p className="mt-1 text-xs text-on-surface-variant">Use at least 8 characters.</p></div><div><label htmlFor="member-mcp-label" className="text-sm font-medium">Account label (optional)</label><Input id="member-mcp-label" className="mt-1" maxLength={120} value={draft.accountLabel} disabled={disabled || !selected.canConnect} onChange={(event) => setDraft((current) => current && { ...current, accountLabel: event.target.value })} /></div></div> : null}
        {busy ? <p role="status" className="text-sm text-on-surface-variant">Saving your credential...</p> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || !selected.canConnect || !draft.reviewed || draft.secret.length < 8 || draft.secret.length > 8192} onClick={() => void save()}>{busy ? "Saving..." : "Save credentials"}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={cancel}>Cancel</Button></div>
      </div> : null}
      {confirmRemove === connection.serverId ? <div id={`member-mcp-remove-${connection.serverId}`} role="group" aria-labelledby={`member-mcp-remove-title-${connection.serverId}`} className="space-y-3 border-t border-outline-variant pt-4 text-sm">
        <h4 ref={removalHeadingRef} tabIndex={-1} id={`member-mcp-remove-title-${connection.serverId}`} className="break-words rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">Remove your saved credential for {connection.serverName}?</h4>
        <p className="text-on-surface-variant">The agent will no longer use this credential. You can save a new one later.</p>
        {error ? <div role="alert" className="space-y-2 text-sm text-danger"><p className="break-words">{error}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => void reload()}>Reload connections</Button></div> : null}
        {busy ? <p role="status" className="text-sm text-on-surface-variant">Removing your credential...</p> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="destructive" disabled={disabled} onClick={() => void remove(connection)}>{busy ? "Removing..." : "Remove now"}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => { pendingFocus.current = `${connection.serverId}:remove`; setConfirmRemove(null); setError(null); }}>Keep credential</Button></div>
      </div> : null}
    </li>)}</ul> : null}
  </section>;
}
