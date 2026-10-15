"use client";

import { type FormEvent, useId, useState } from "react";

import {
  MCP_APP_CSP_DIRECTIVE_LABELS,
  MCP_APP_CSP_DIRECTIVES,
  type AdminMcpServer,
  type McpAppCspDirective
} from "@cogniplane/shared-types";
import { describeCspSourceError, parseCspSource } from "@cogniplane/shared-types/csp-sources";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminMcpWidgetDomains } from "../../../hooks/use-admin-mcp-widget-domains";
import { widgetDomainRows } from "./admin-mcp-widget-domains.logic";

/**
 * The outside domains that interactive views from one connection may use. A view
 * asks for domains in its own description. A view gets only the ones that an
 * administrator approved here, so a new connection starts with none.
 */
export function AdminMcpWidgetDomains({ server, open }: { server: AdminMcpServer; open: boolean }) {
  const { domains, loading, loadError, reload, changing, changeError, approve, revoke, clearChangeError } =
    useAdminMcpWidgetDomains(server.serverId, open);
  const [directive, setDirective] = useState<McpAppCspDirective>("connectDomains");
  const [source, setSource] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const id = useId();
  const rows = domains ? widgetDomainRows(domains) : [];

  async function change(action: typeof approve | typeof revoke, row: { directive: McpAppCspDirective; source: string }) {
    setInputError(null);
    try {
      await action({ directive: row.directive, source: row.source });
    } catch {
      // The page shows the error from the saved state.
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearChangeError();
    // The server applies the same rules. This only saves the round trip.
    const parsed = parseCspSource(source.trim(), directive);
    if (!parsed.ok) {
      setInputError(describeCspSourceError(parsed.reason));
      return;
    }
    setInputError(null);
    try {
      await approve({ directive, source: parsed.source.normalized });
      setSource("");
    } catch {
      // The page shows the error, and the form keeps what was typed.
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="w-full border-t border-outline-variant pt-3 text-sm">
      <h4 id={`${id}-heading`} className="font-semibold">Widget domains</h4>
      <p className="mt-1 text-xs text-on-surface-variant">
        Interactive views from this connection can ask to load content from other domains or to send requests to them.
        A view gets only the domains that you approve here. Nothing is approved until you do it. Approve a domain
        only if you trust it with what the view shows.
      </p>

      {loading ? <p role="status" className="mt-2 text-on-surface-variant">Loading widget domains…</p> : null}
      {loadError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-danger">{loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>Reload</Button>
        </div>
      ) : null}

      {domains ? (
        rows.length === 0 ? (
          <p className="mt-2 text-xs text-on-surface-variant">
            No view from this connection has asked for an outside domain yet. A request appears here after a member
            opens one of its views.
          </p>
        ) : (
          <ul aria-label="Widget domains" className="mt-2 divide-y divide-outline-variant">
            {rows.map((row) => (
              <li key={`${row.directive} ${row.source}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <code className="break-all text-xs">{row.source}</code>
                  <p className="text-xs text-on-surface-variant">
                    {MCP_APP_CSP_DIRECTIVE_LABELS[row.directive]}
                    {" · "}
                    <span className={row.approved ? "text-success" : "text-warning"}>
                      {row.approved ? "Approved" : "Waiting for approval"}
                    </span>
                    {" · "}
                    {row.lastRequestedAt
                      ? `Last requested ${new Date(row.lastRequestedAt).toLocaleString()}`
                      : "No view has asked for it"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={changing}
                  aria-label={`${row.approved ? "Remove" : "Approve"} ${row.source} for ${MCP_APP_CSP_DIRECTIVE_LABELS[row.directive].toLowerCase()}`}
                  onClick={() => void change(row.approved ? revoke : approve, row)}
                >
                  {row.approved ? "Remove" : "Approve"}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form
        aria-label={`Approve a domain for ${server.serverName}`}
        onSubmit={(event) => void handleAdd(event)}
        className="mt-3 flex flex-col gap-2"
        noValidate
      >
        <p className="text-xs text-on-surface-variant">
          Approve a domain before a view asks for it. Use https://, a host name, and an optional port. A wildcard can
          only start the name, as in https://*.example.com. It cannot cover a whole public suffix, such as *.com.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-directive`}>Used for</Label>
            <select
              id={`${id}-directive`}
              className="h-9 rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-sm"
              value={directive}
              onChange={(event) => { setDirective(event.target.value as McpAppCspDirective); setInputError(null); }}
            >
              {MCP_APP_CSP_DIRECTIVES.map((key) => (
                <option key={key} value={key}>{MCP_APP_CSP_DIRECTIVE_LABELS[key]}</option>
              ))}
            </select>
          </div>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${id}-source`}>Domain</Label>
            <Input
              id={`${id}-source`}
              value={source}
              onChange={(event) => { setSource(event.target.value); setInputError(null); }}
              placeholder="https://cdn.example.com"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? `${id}-error` : undefined}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={changing}>Approve domain</Button>
        </div>
        {inputError ? <p id={`${id}-error`} role="alert" className="text-xs text-danger">{inputError}</p> : null}
        {changeError ? <p role="alert" className="text-xs text-danger">{changeError}</p> : null}
      </form>
    </section>
  );
}
