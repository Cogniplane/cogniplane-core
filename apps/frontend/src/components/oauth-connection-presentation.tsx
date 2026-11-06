"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { OAuthConnectionBusyKey } from "../hooks/use-oauth-connection";
import { PILL_AMBER, PILL_BLUE, PILL_GRAY } from "../lib/ui-tokens";

export type OAuthConnectionReadState = {
  isLoading?: boolean;
  statusError?: string | null;
  onRetry?: () => void;
};

export function OAuthConnectionSectionHeading(input: { provider: string }) {
  return <div className="space-y-3">
    <Link href="/settings/connections" className="inline-flex min-h-9 items-center rounded-md text-sm text-on-surface-variant underline underline-offset-4 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary">
      Connected accounts
    </Link>
    <h1 className="text-2xl font-semibold text-on-surface">{input.provider}</h1>
  </div>;
}

// A failed read says nothing about whether an account is connected.
export function OAuthConnectionReadBoundary(input: OAuthConnectionReadState & { known: boolean; children: ReactNode }) {
  return <>
    {input.statusError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-surface p-4 text-sm">
      <div className="min-w-0 space-y-1 break-words"><p className="font-semibold text-danger">Could not check connection status</p><p className="text-on-surface">{input.statusError}</p>{input.known ? <p className="text-on-surface-variant">The account below is from the last successful check.</p> : null}</div>
      {input.onRetry ? <Button type="button" size="sm" variant="outline" disabled={input.isLoading} onClick={input.onRetry}>{input.isLoading ? "Checking..." : "Retry status"}</Button> : null}
    </div> : null}
    {input.known ? <>
      {input.isLoading ? <p role="status" className="text-sm text-on-surface-variant">Refreshing connection status. Showing the last known account.</p> : null}
      {input.children}
    </> : !input.statusError ? <div role="status" className="space-y-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      <p className="text-sm text-on-surface-variant">Checking your connection...</p>
      <div aria-hidden="true" className="h-5 w-40 rounded bg-surface-container" /><div aria-hidden="true" className="h-4 w-3/4 rounded bg-surface-container" />
    </div> : null}
  </>;
}

export function OAuthConnectionOverview(input: { headline: string; state: string; suspended: boolean; connected: boolean; description: ReactNode; identity?: ReactNode; diagnostics?: ReactNode; children: ReactNode }) {
  return <div className="min-w-0 space-y-5 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 sm:p-6">
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-on-surface [overflow-wrap:anywhere]">{input.headline}</h2>
        <span className={input.suspended ? PILL_AMBER : input.connected ? PILL_BLUE : PILL_GRAY}>{input.state}</span>
      </div>
      {input.identity ? <div className="min-w-0 space-y-1 break-words text-sm text-on-surface-variant [overflow-wrap:anywhere]">{input.identity}</div> : null}
      <p className="max-w-prose text-sm text-on-surface-variant">{input.description}</p>
    </div>
    <div className="min-w-0 space-y-3 border-t border-outline-variant pt-5">{input.children}</div>
    {input.diagnostics ? <details className="min-w-0 border-t border-outline-variant pt-4 text-sm text-on-surface-variant [overflow-wrap:anywhere]"><summary className="min-h-9 cursor-pointer rounded-md font-medium text-on-surface focus-visible:outline-2 focus-visible:outline-primary">Connection diagnostics</summary><div className="space-y-1 pt-2">{input.diagnostics}</div></details> : null}
  </div>;
}

export function OAuthConnectionAvailability(input: { provider: string; configured: boolean; enabled: boolean }) {
  if (input.enabled && input.configured) return null;
  return <div className="space-y-1 rounded-lg bg-surface-container p-3 text-sm text-on-surface-variant">
    <p className="font-medium text-on-surface">{!input.enabled ? `${input.provider} is disabled by your organization` : `${input.provider} is not set up yet`}</p>
    <p>Ask an administrator to {!input.enabled ? "enable this service" : "complete setup"} in Admin &gt; Connections. You can still disconnect a saved account.</p>
  </div>;
}

/** Confirmation requires a recognizable identity attested by the provider. */
export type SuspendedConnection = {
  confirm: { account: string; onConfirm: () => void } | null;
};

export function SuspendedConnectionNotice(input: {
  confirm: { account: string; onConfirm: () => void } | null;
  busy: boolean;
  disabled?: boolean;
}) {
  return <div role="status" className="flex min-w-0 flex-col gap-2 rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm [overflow-wrap:anywhere]">
    <p className="font-semibold text-on-surface">Suspended because your account security changed</p>
    {input.confirm ? <>
      <p className="text-on-surface-variant">Your password changed or you signed out on all devices. The agent does not use this connection until you confirm it. Confirm only if you connected {input.confirm.account} yourself. If you do not know it, disconnect it.</p>
      <div><Button type="button" size="sm" disabled={input.busy || input.disabled === true} onClick={input.confirm.onConfirm}>{input.busy ? "Confirming..." : "Confirm connection"}</Button></div>
    </> : <p className="text-on-surface-variant">Your password changed or you signed out on all devices. The agent does not use this connection. Connect again, or disconnect it.</p>}
  </div>;
}

export function OAuthConnectionActions(input: {
  busyKey: OAuthConnectionBusyKey | null;
  configured: boolean;
  connected: boolean;
  connectLabel: string;
  reconnectLabel: string;
  error: string | null;
  flashMessage: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  locked?: boolean;
  suspended?: SuspendedConnection;
  children?: ReactNode;
}) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const returnAfterDisconnect = useRef(false);
  useLayoutEffect(() => {
    if (returnAfterDisconnect.current && !input.connected && input.busyKey === null) {
      returnAfterDisconnect.current = false;
      (connectRef.current?.disabled ? actionsRef.current : connectRef.current)?.focus();
    } else if (input.error) returnAfterDisconnect.current = false;
  }, [input.connected, input.busyKey, input.error]);
  const blocked = input.busyKey !== null || input.locked === true;
  const connectLabel = input.busyKey === "connect" ? "Redirecting..." : input.connected ? input.reconnectLabel : input.connectLabel;
  return <>
    {input.flashMessage ? <p role="status" className="text-sm text-on-surface-variant">{input.flashMessage}</p> : null}
    {input.error ? <p role="alert" className="break-words text-sm text-danger">{input.error}</p> : null}
    {input.suspended ? <SuspendedConnectionNotice confirm={input.suspended.confirm} busy={input.busyKey === "confirm"} disabled={blocked || !input.configured} /> : null}
    {input.children}
    {input.busyKey ? <p role="status" className="text-sm text-on-surface-variant">{input.busyKey === "connect" ? "Opening provider authorization..." : input.busyKey === "disconnect" ? "Removing this connection..." : "Confirming this account..."}</p> : null}
    <div ref={actionsRef} tabIndex={-1} role="group" aria-label="Connection actions" className="flex flex-wrap items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-primary" aria-busy={input.busyKey !== null}>
      <Button ref={connectRef} type="button" disabled={!input.configured || blocked} onClick={input.onConnect}>{connectLabel}</Button>
      {input.connected ? <Button type="button" variant="outline" disabled={blocked} onClick={() => { returnAfterDisconnect.current = true; input.onDisconnect(); }}>{input.busyKey === "disconnect" ? "Disconnecting..." : "Disconnect"}</Button> : null}
    </div>
    {input.connected ? <p className="text-xs text-on-surface-variant">Disconnect stops this connection in Cogniplane. Manage the provider's own app permissions in your provider account.</p> : null}
  </>;
}
