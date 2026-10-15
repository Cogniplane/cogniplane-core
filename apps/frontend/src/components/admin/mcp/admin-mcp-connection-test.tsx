"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminMcpConnectionTest, AdminMcpServer } from "@cogniplane/shared-types";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import { testAdminMcpConnection } from "@/lib/admin-api";
import { Button } from "@/components/ui/button";

export const reachabilityLabel: Record<AdminMcpConnectionTest["reachability"], string> = {
  reachable: "Reachable", unreachable: "Unreachable", unknown: "Not confirmed"
};
const authenticationLabel: Record<AdminMcpConnectionTest["authentication"], string> = {
  accepted: "Accepted", not_required: "Not required", indeterminate: "Not confirmed", credential_missing: "Credential missing"
};
const discoveryLabel: Record<AdminMcpConnectionTest["toolDiscovery"], string> = {
  succeeded: "Succeeded", partial: "Incomplete", failed: "Failed", not_tested: "Not tested"
};

function requestError(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return "The saved connection changed. Reload connections before testing it again.";
    if (cause.status === 404) return "This connection is no longer available. Reload connections.";
    if (cause.status === 401) return "Your session expired. Sign in again before testing.";
    if (cause.status === 403) return "You no longer have access to test this connection.";
  }
  return "The connection test could not finish. Check the saved URL and credentials, then try again.";
}

export function AdminMcpConnectionTestCard({ server, listGeneration = 0, unsavedChanges, onTested, onReload }: {
  server: AdminMcpServer;
  listGeneration?: number;
  unsavedChanges: boolean;
  onTested?: () => void;
  onReload?: () => void;
}) {
  const { user } = useAuth();
  const scopeKey = `${user?.tenantId ?? ""}:${user?.userId ?? ""}`;
  const [local, setLocal] = useState<{ scopeKey: string; configHash: string; listGeneration: number; result: AdminMcpConnectionTest } | null>(null);
  const [error, setError] = useState<{ scopeKey: string; message: string } | null>(null);
  const [deniedForScope, setDeniedForScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestId = useRef(0);
  const currentScope = useRef(scopeKey);
  const currentConfig = useRef(`${server.serverId}:${server.version}:${server.configHash}`);
  const currentListGeneration = useRef(listGeneration);
  const testButton = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const focusResult = useRef(false);
  const focusError = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    currentScope.current = scopeKey;
    currentConfig.current = `${server.serverId}:${server.version}:${server.configHash}`;
    currentListGeneration.current = listGeneration;
    return () => { alive.current = false; };
  }, [scopeKey, server.serverId, server.version, server.configHash, listGeneration]);
  const personal = server.credentialScope === "personal";
  // Server version and config hash identify an organization result. A personal result also depends
  // on the admin's credential version, which only a fresh list shows. So a list refetch replaces it.
  const sameList = (generation: number) => !personal || generation === listGeneration;
  const errorText = error?.scopeKey === scopeKey ? error.message : null;
  const valid = (result: AdminMcpConnectionTest | null | undefined) => result && result.serverId === server.serverId &&
    result.configVersion === server.version && result.configHash === server.configHash &&
    (!personal || result.testedUserId === user?.userId);
  const result = deniedForScope === scopeKey ? null : local?.scopeKey === scopeKey && local.configHash === server.configHash && sameList(local.listGeneration) && valid(local.result) ? local.result
    : valid(server.connectionTest) ? server.connectionTest : null;
  useEffect(() => {
    if (result && focusResult.current) {
      focusResult.current = false;
      if (document.activeElement === document.body || document.activeElement === testButton.current) resultHeading.current?.focus();
    }
  }, [result]);
  useEffect(() => {
    if (errorText && focusError.current) {
      focusError.current = false;
      if (document.activeElement === document.body || document.activeElement === testButton.current) errorMessage.current?.focus();
    }
  }, [errorText]);

  const test = async () => {
    if (busyRef.current || unsavedChanges || !user) return;
    busyRef.current = true;
    const stamp = ++requestId.current;
    const testedScope = scopeKey;
    const testedConfig = `${server.serverId}:${server.version}:${server.configHash}`;
    const keepFocus = document.activeElement === testButton.current;
    setBusy(true); setError(null); setLocal(null);
    try {
      const checked = await testAdminMcpConnection(server.serverId, { expectedVersion: server.version, expectedConfigHash: server.configHash });
      if (!alive.current || stamp !== requestId.current || currentScope.current !== testedScope || currentConfig.current !== testedConfig) return;
      if (!valid(checked)) { setError({ scopeKey: testedScope, message: "The saved connection changed. Reload connections before testing it again." }); focusError.current = keepFocus; return; }
      setDeniedForScope(null);
      // The server checked the credential version before it replied. Pair the result with the list that is current now.
      setLocal({ scopeKey: testedScope, configHash: server.configHash, listGeneration: currentListGeneration.current, result: checked });
      focusResult.current = keepFocus;
      onTested?.();
    } catch (cause) {
      if (!alive.current || stamp !== requestId.current || currentScope.current !== testedScope || currentConfig.current !== testedConfig) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setDeniedForScope(testedScope);
      setError({ scopeKey: testedScope, message: requestError(cause) });
      focusError.current = keepFocus;
    } finally { busyRef.current = false; if (alive.current && stamp === requestId.current) setBusy(false); }
  };

  return <div className="w-full border-t border-outline-variant pt-3 text-sm">
    <div className="flex flex-wrap items-center gap-2"><Button ref={testButton} type="button" size="sm" variant="outline" disabled={busy || unsavedChanges || !user} onClick={() => void test()}>{busy ? "Testing connection…" : `Test saved version ${server.version}`}</Button><span className="text-xs text-on-surface-variant">Discovery only. No tools run.</span></div>
    {unsavedChanges ? <p className="mt-2 text-xs text-on-surface-variant">Save or discard your edits before testing this connection.</p> : null}
    {personal ? <p className="mt-2 text-xs text-on-surface-variant">This checks your saved credential only. Each member needs their own credential.</p> : <p className="mt-2 text-xs text-on-surface-variant">This checks the saved organization connection.</p>}
    {busy ? <p role="status" className="mt-2 text-on-surface-variant">Checking reachability, authentication, and tool discovery…</p> : null}
    {errorText ? <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-danger-surface p-3"><p ref={errorMessage} tabIndex={-1} role="alert" className="text-danger">{errorText}</p>{onReload && /Reload connections/.test(errorText) ? <Button type="button" size="sm" variant="outline" onClick={onReload}>Reload connections</Button> : null}</div> : null}
    {!busy && result ? <div className="mt-3 rounded-md border border-outline-variant bg-surface p-3"><h4 ref={resultHeading} tabIndex={-1} className="font-semibold">{personal ? "Your credential check" : "Organization connection check"}</h4><p className="mt-1 text-xs text-on-surface-variant">Saved version {result.configVersion} · checked {new Date(result.checkedAt).toLocaleString()}</p><dl className="mt-3 grid gap-2 sm:grid-cols-3"><div><dt className="text-xs text-on-surface-variant">Reachability</dt><dd>{reachabilityLabel[result.reachability]}</dd></div><div><dt className="text-xs text-on-surface-variant">Authentication</dt><dd>{authenticationLabel[result.authentication]}</dd></div><div><dt className="text-xs text-on-surface-variant">Tool discovery</dt><dd>{discoveryLabel[result.toolDiscovery]}{result.toolCount === null ? "" : ` · ${result.toolCount} tools seen`}</dd></div></dl><p className="mt-3 text-sm text-on-surface-variant">{result.message}</p></div> : !busy && !errorText ? <p className="mt-2 text-xs text-on-surface-variant">Test needed for saved version {server.version}.</p> : null}
  </div>;
}
