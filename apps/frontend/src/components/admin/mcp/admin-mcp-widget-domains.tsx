"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";

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
import { focusMcpElement, keepMcpFocusVisible, MCP_TEXT_FOCUS } from "./admin-mcp-focus";

function directiveInSentence(directive: McpAppCspDirective) {
  const label = MCP_APP_CSP_DIRECTIVE_LABELS[directive];
  return directive === "baseUriDomains" ? label : label.toLowerCase();
}

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
  const [decisionSuccess, setDecisionSuccess] = useState<string | null>(null);
  const inputRevision = useRef(0);
  const pending = useRef(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  const rowFeedback = useRef(new Map<string, HTMLParagraphElement>());
  const rowFocus = useRef<{ node: HTMLParagraphElement; owned: boolean } | null>(null);
  const [rowDecision, setRowDecision] = useState<string | null>(null);
  const id = useId();
  const rows = domains ? widgetDomainRows(domains) : [];
  const errorInRow = rowDecision !== null && rows.some(row => `${row.directive} ${row.source}` === rowDecision);
  useEffect(() => {
    const previous = rowFocus.current;
    if (!changing && previous?.owned && !previous.node.isConnected && document.activeElement === document.body) {
      focusMcpElement(feedback.current);
      rowFocus.current = null;
    } else if (previous?.owned) {
      keepMcpFocusVisible(previous.node);
    }
  }, [changing, domains, changeError]);
  useEffect(() => {
    if (feedback.current) keepMcpFocusVisible(feedback.current);
  }, [changing, decisionSuccess, changeError]);

  async function change(action: typeof approve | typeof revoke, row: { directive: McpAppCspDirective; source: string; approved: boolean }, trigger: HTMLButtonElement) {
    if (pending.current) return;
    pending.current = true;
    const key = `${row.directive} ${row.source}`;
    setRowDecision(key);
    setDecisionSuccess(null);
    clearChangeError();
    const target = rowFeedback.current.get(key);
    if (target && document.activeElement === trigger) {
      focusMcpElement(target);
      rowFocus.current = { node: target, owned: true };
    }
    setInputError(null);
    try {
      await action({ directive: row.directive, source: row.source });
      setDecisionSuccess(`${row.approved ? "Removed approval for" : "Approved"} ${row.source} for ${directiveInSentence(row.directive)}.`);
    } catch {
      // The page shows the error from the saved state.
    } finally {
      pending.current = false;
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    clearChangeError();
    setDecisionSuccess(null);
    // The server applies the same rules. This only saves the round trip.
    const parsed = parseCspSource(source.trim(), directive);
    if (!parsed.ok) {
      setInputError(describeCspSourceError(parsed.reason));
      return;
    }
    setInputError(null);
    setRowDecision(null);
    const sentRevision = inputRevision.current;
    pending.current = true;
    if (event.currentTarget.contains(document.activeElement)) focusMcpElement(feedback.current);
    try {
      await approve({ directive, source: parsed.source.normalized });
      setDecisionSuccess(`Approved ${parsed.source.normalized} for ${directiveInSentence(directive)}.${inputRevision.current !== sentRevision ? " Later input stays in the form." : ""}`);
      if (inputRevision.current === sentRevision) setSource("");
    } catch {
      // The page shows the error, and the form keeps what was typed.
    } finally {
      pending.current = false;
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="w-full border-t border-outline-variant pt-3 text-sm">
      <h4 id={`${id}-heading`} className="font-semibold">Widget domains</h4>
      <p className="mt-1 text-sm text-on-surface-variant">
        Interactive views from this connection can ask to load content from other domains or to send requests to them.
        A view gets only the domains that you approve here. Nothing is approved until you do it. Approve a domain
        only if you trust it with what the view shows.
      </p>

      {loading ? <p role="status" className="mt-2 text-on-surface-variant">Loading widget domains…</p> : null}
      {loadError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-danger">{domains ? `Showing saved domain decisions. Refresh failed. ${loadError}` : loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>Reload</Button>
        </div>
      ) : null}

      {domains ? (
        rows.length === 0 ? (
          <p className="mt-2 text-sm text-on-surface-variant">
            No view from this connection has asked for an outside domain yet. A request appears here after a member
            opens one of its views.
          </p>
        ) : (
          <ul aria-label="Widget domains" className="mt-2 divide-y divide-outline-variant">
            {rows.map((row) => (
              <li key={`${row.directive} ${row.source}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 flex-1 basis-64">
                  <code className="break-all text-xs">{row.source}</code>
                  <p
                    ref={(node) => { const key = `${row.directive} ${row.source}`; if (node) rowFeedback.current.set(key, node); else rowFeedback.current.delete(key); }}
                    tabIndex={-1}
                    onBlur={() => { const previous = rowFocus.current; if (previous && previous.node === rowFeedback.current.get(`${row.directive} ${row.source}`)) previous.owned = false; }}
                    role={rowDecision === `${row.directive} ${row.source}` && changeError ? "alert" : undefined}
                    className={`text-sm text-on-surface-variant ${MCP_TEXT_FOCUS}`}
                  >
                    {MCP_APP_CSP_DIRECTIVE_LABELS[row.directive]}
                    {" · "}
                    <span className={row.approved ? "text-success" : "text-warning"}>
                      {row.approved ? "Approved" : "Waiting for approval"}
                    </span>
                    {" · "}
                    {row.lastRequestedAt
                      ? `Last requested ${new Date(row.lastRequestedAt).toLocaleString()}`
                      : "No view has asked for it"}
                    {rowDecision === `${row.directive} ${row.source}` && changing ? " · Saving this domain decision…" : null}
                    {rowDecision === `${row.directive} ${row.source}` && changeError ? <span className="text-danger"> · {changeError}</span> : null}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={changing}
                  aria-label={`${row.approved ? "Remove" : "Approve"} ${row.source} for ${directiveInSentence(row.directive)}`}
                  onClick={(event) => void change(row.approved ? revoke : approve, row, event.currentTarget)}
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
        <p className="text-sm text-on-surface-variant">
          Approve a domain before a view asks for it. Use https://, a host name, and an optional port. A wildcard can
          only start the name, as in https://*.example.com. It cannot cover a whole public suffix, such as *.com.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 max-w-full flex-col gap-1.5">
            <Label htmlFor={`${id}-directive`}>Used for</Label>
            <select
              id={`${id}-directive`}
              className="h-10 max-w-full rounded-md border border-input bg-control px-3 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
              value={directive}
              onChange={(event) => { inputRevision.current += 1; setDirective(event.target.value as McpAppCspDirective); setInputError(null); }}
            >
              {MCP_APP_CSP_DIRECTIVES.map((key) => (
                <option key={key} value={key}>{MCP_APP_CSP_DIRECTIVE_LABELS[key]}</option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 basis-56 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${id}-source`}>Domain</Label>
            <Input
              id={`${id}-source`}
              className="h-10"
              value={source}
              onChange={(event) => { inputRevision.current += 1; setSource(event.target.value); setInputError(null); }}
              placeholder="https://cdn.example.com"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? `${id}-error` : undefined}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="min-h-10" disabled={changing}>Approve domain</Button>
        </div>
        {inputError ? <p id={`${id}-error`} role="alert" className="text-sm text-danger">{inputError}</p> : null}
        <p ref={feedback} tabIndex={-1} role={changeError && !errorInRow ? "alert" : "status"} className={`text-sm ${MCP_TEXT_FOCUS} ${changeError && !errorInRow ? "text-danger" : decisionSuccess ? "text-success" : "text-on-surface-variant"}`}>
          {changeError && !errorInRow ? changeError : changing && !rowDecision ? "Saving this domain decision. Later input stays in the form." : decisionSuccess || "Domain decisions save immediately, separately from connection settings."}
        </p>
      </form>
    </section>
  );
}
