"use client";

import Link from "next/link";

import { IntegrationLogo } from "./integration-logo";
import { Button } from "./ui/button";

type ConnectedAccountRowProps = {
  service: string;
  slug: string;
  description: string;
  identity: string | null;
  // A security change suspended the connection; the owner confirms it in Details.
  suspended?: boolean;
  configured: boolean;
  statusKnown?: boolean;
  tenantEnabled?: boolean;
  isLoading: boolean;
  busyKey: "connect" | "disconnect" | "confirm" | null;
  error: string | null;
  statusError: string | null;
  detailsHref: string;
  onConnect: () => void;
  onRetry: () => void;
};

export function ConnectedAccountRow(input: ConnectedAccountRowProps) {
  const { service, identity, configured, isLoading, busyKey, error, statusError } = input;
  const known = input.statusKnown ?? (!isLoading && !statusError);
  const state = !known
    ? statusError ? "Status unavailable" : "Checking connection"
    : !configured
      ? input.tenantEnabled === false ? "Disabled by your organization" : "Not available"
      : identity ? input.suspended ? "Suspended" : "Connected" : "Not connected";

  return (
    <li className="grid gap-4 border-b border-outline-variant px-4 py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${input.slug === "github" ? "bg-slate-900" : "bg-surface-container"}`}>
          <IntegrationLogo slug={input.slug} name={service} category="Productivity" size={24} />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-on-surface">{service}</h2>
          <p className="mt-0.5 text-sm text-on-surface-variant">{input.description}</p>
          <p className="mt-2 min-w-0 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
            <span className="font-medium">{state}</span>
            {identity ? <span className="text-on-surface-variant"> · {identity}</span> : null}
          </p>
          {known && isLoading ? <p role="status" className="mt-1 text-xs text-on-surface-variant">Refreshing connection status...</p> : null}
          {known && statusError ? <p className="mt-1 text-xs text-on-surface-variant">Showing the last known account. Its current status could not be checked.</p> : null}
          {identity && input.suspended && !isLoading && !statusError ? (
            <p className="mt-1 text-sm text-on-surface-variant">
              Your account security changed. Open Details to review this connection.
            </p>
          ) : null}
          {error || statusError ? <p role="alert" className="mt-2 break-words text-sm text-danger">{error ?? statusError}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!known || isLoading || !configured || busyKey !== null || Boolean(statusError)}
          onClick={input.onConnect}
          aria-label={`${identity ? "Reconnect" : "Connect"} ${service}`}
        >
          {busyKey === "connect" ? "Redirecting..." : identity ? "Reconnect" : "Connect"}
        </Button>
        {statusError ? (
          <Button type="button" size="sm" variant="outline" disabled={isLoading} onClick={input.onRetry}>
            {isLoading ? "Checking..." : "Retry"}
          </Button>
        ) : null}
        <Link
          href={input.detailsHref}
          aria-label={`Details for ${service}`}
          className="rounded-md px-2 py-1.5 text-sm text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          Details
        </Link>
      </div>
    </li>
  );
}
