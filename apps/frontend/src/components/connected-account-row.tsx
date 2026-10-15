"use client";

import Link from "next/link";

import { IntegrationLogo } from "./integration-logo";
import { Button } from "./ui/button";

type ConnectedAccountRowProps = {
  service: string;
  slug: string;
  description: string;
  identity: string | null;
  configured: boolean;
  isLoading: boolean;
  busyKey: "connect" | "disconnect" | null;
  error: string | null;
  statusError: string | null;
  detailsHref: string;
  onConnect: () => void;
  onRetry: () => void;
};

export function ConnectedAccountRow(input: ConnectedAccountRowProps) {
  const { service, identity, configured, isLoading, busyKey, error, statusError } = input;
  const state = isLoading
    ? "Checking connection"
    : statusError
      ? "Status unavailable"
      : !configured
        ? "Not available"
        : identity
        ? "Connected"
        : "Not connected";

  return (
    <li className="grid gap-4 border-b border-outline-variant px-4 py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${input.slug === "github" ? "bg-slate-900" : "bg-surface-container"}`}>
          <IntegrationLogo slug={input.slug} name={service} category="Productivity" size={24} />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-on-surface">{service}</h2>
          <p className="mt-0.5 text-sm text-on-surface-variant">{input.description}</p>
          <p className="mt-2 min-w-0 break-words text-sm text-on-surface">
            <span className="font-medium">{state}</span>
            {identity ? <span className="text-on-surface-variant"> · {identity}</span> : null}
          </p>
          {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        <Button
          type="button"
          size="sm"
          disabled={isLoading || !configured || busyKey !== null || Boolean(statusError)}
          onClick={input.onConnect}
          aria-label={`${identity ? "Reconnect" : "Connect"} ${service}`}
        >
          {busyKey === "connect" ? "Redirecting..." : identity ? "Reconnect" : "Connect"}
        </Button>
        {statusError ? (
          <Button type="button" size="sm" variant="outline" onClick={input.onRetry}>
            Retry
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
