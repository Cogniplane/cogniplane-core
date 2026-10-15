"use client";

import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { AdminMcpServer } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { DisclosureRow } from "../overview-row";
import type { McpAudience } from "../../../lib/admin-api";
import { deriveMcpServerId, getMcpAvailability, getMcpUpstreamWarnings } from "./admin-mcp-card.logic";
import { AdminMcpConnectionTestCard, reachabilityLabel } from "./admin-mcp-connection-test";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

type McpDraft = {
  serverId: string;
  serverName: string;
  description: string;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string;
  upstreamAuthType: AdminMcpServer["upstreamAuthType"];
  credentialScope: "organization" | "personal";
  upstreamAuthName: string;
  upstreamAuthSecret: string;
  audience: McpAudience;
  customId: boolean;
  customRoute: boolean;
};

const emptyMcpDraft: McpDraft = {
  serverId: "",
  serverName: "",
  description: "",
  mode: "proxy",
  routePath: "/mcp/",
  upstreamUrl: "",
  upstreamAuthType: "none",
  credentialScope: "organization",
  upstreamAuthName: "",
  upstreamAuthSecret: "",
  audience: "off",
  customId: false,
  customRoute: false
};

function draftForServer(server: AdminMcpServer): McpDraft {
  return {
    serverId: server.serverId,
    serverName: server.serverName,
    description: server.description ?? "",
    mode: server.mode,
    routePath: server.routePath,
    upstreamUrl: server.upstreamUrl ?? "",
    upstreamAuthType: server.upstreamAuthType,
    credentialScope: server.credentialScope ?? "organization",
    upstreamAuthName: server.upstreamAuthName ?? "",
    upstreamAuthSecret: "",
    audience: getMcpAvailability(server).audience,
    customId: true,
    customRoute: true
  };
}

export function AdminMcpCard(props: {
  targetServerId?: string | null;
  mcpServers: AdminMcpServer[];
  listGeneration?: number;
  busyKey: string | null;
  saveError?: string | null;
  onSubmit: (
    input: {
      serverId: string;
      serverName: string;
      description: string | null;
      mode: "managed" | "proxy";
      routePath: string;
      upstreamUrl: string | null;
      upstreamAuthType: AdminMcpServer["upstreamAuthType"];
      credentialScope: "organization" | "personal";
      upstreamAuthName: string | null;
      upstreamAuthSecret?: string | null;
      audience: McpAudience;
    },
    editingId: string | null
  ) => Promise<void>;
  onSetInheritedAudience: (serverId: string, audience: McpAudience) => Promise<void>;
  onTested?: () => void;
  onReload?: () => void;
  /** More content for the open row of a connection. `open` is true while its row is open. */
  renderServerExtras?: (server: AdminMcpServer, open: boolean) => ReactNode;
}) {
  const targetServer = props.mcpServers.find((server) => server.serverId === props.targetServerId);
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(() => targetServer ? draftForServer(targetServer) : emptyMcpDraft);
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(targetServer?.serverId ?? null);
  const [showForm, setShowForm] = useState(Boolean(targetServer));
  // The open row. It stays open after a save, so the admin can test the saved version.
  const [expandedId, setExpandedId] = useState<string | null>(targetServer?.serverId ?? null);
  const { user } = useAuth();
  const upstreamWarnings = getMcpUpstreamWarnings(mcpDraft.upstreamUrl);
  const formRef = useRef<HTMLFormElement>(null);
  const inheritedServer = props.mcpServers.find((server) =>
    server.serverId === editingMcpServerId && server.ownerTenantId === "system"
  );

  function handleCancel() {
    setShowForm(false);
    setEditingMcpServerId(null);
    setMcpDraft(emptyMcpDraft);
  }

  function handleEdit(server: AdminMcpServer) {
    setEditingMcpServerId(server.serverId);
    setMcpDraft(draftForServer(server));
    setShowForm(true);
  }

  useEffect(() => {
    if (showForm && editingMcpServerId === props.targetServerId) {
      formRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      formRef.current?.focus();
    }
  }, [showForm, editingMcpServerId, props.targetServerId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      if (inheritedServer) {
        await props.onSetInheritedAudience(inheritedServer.serverId, mcpDraft.audience);
      } else {
        await props.onSubmit(
        {
          serverId: mcpDraft.serverId,
          serverName: mcpDraft.serverName,
          description: mcpDraft.description || null,
          mode: mcpDraft.mode,
          routePath: mcpDraft.routePath,
          upstreamUrl: mcpDraft.mode === "proxy" ? mcpDraft.upstreamUrl || null : null,
          upstreamAuthType: mcpDraft.mode === "proxy" ? mcpDraft.upstreamAuthType : "none",
          credentialScope: mcpDraft.mode === "proxy" ? mcpDraft.credentialScope : "organization",
          upstreamAuthName:
            mcpDraft.mode === "proxy" &&
            (mcpDraft.upstreamAuthType === "header" || mcpDraft.upstreamAuthType === "query")
              ? mcpDraft.upstreamAuthName || null
              : null,
          upstreamAuthSecret:
            mcpDraft.mode !== "proxy" || mcpDraft.credentialScope === "personal" || mcpDraft.upstreamAuthType === "none"
              ? null
              : mcpDraft.upstreamAuthSecret || (editingMcpServerId ? undefined : null),
          audience: mcpDraft.audience
        },
        editingMcpServerId
        );
      }
      setExpandedId(inheritedServer?.serverId ?? mcpDraft.serverId);
      setEditingMcpServerId(null);
      setMcpDraft(emptyMcpDraft);
      setShowForm(false);
    } catch {
      return;
    }
  }

  const form = showForm ? (
          <form
            ref={formRef}
            tabIndex={-1}
            aria-label={editingMcpServerId ? `Manage ${mcpDraft.serverName}` : "Add connection"}
            onSubmit={(event) => void handleSubmit(event)}
            className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface-container-low p-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-server-name">Name</Label>
                <Input
                  id="mcp-server-name"
                  value={mcpDraft.serverName}
                  readOnly={Boolean(inheritedServer)}
                  onChange={(e) => setMcpDraft((current) => {
                    const serverName = e.target.value;
                    const serverId = current.customId
                      ? current.serverId
                      : deriveMcpServerId(serverName, props.mcpServers.map((server) => server.serverId));
                    return {
                      ...current,
                      serverName,
                      serverId,
                      routePath: current.customRoute ? current.routePath : `/mcp/${serverId}`
                    };
                  })}
                  placeholder="Research database"
                  required
                />
              </div>
              {mcpDraft.mode === "proxy" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-upstream">URL</Label>
                  <Input
                    id="mcp-upstream"
                    type="url"
                    value={mcpDraft.upstreamUrl}
                    onChange={(e) => setMcpDraft((c) => ({ ...c, upstreamUrl: e.target.value }))}
                    placeholder="https://example.com/mcp"
                    required
                    readOnly={Boolean(inheritedServer)}
                  />
                  {upstreamWarnings.http ? <p role="status" className="text-sm text-warning">HTTP sends requests without encryption and can expose credentials.</p> : null}
                  {upstreamWarnings.privateNetwork ? <p role="status" className="text-sm text-warning">This address appears to be on a local or shared network. The backend will send requests to it.</p> : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-description">Description</Label>
              <Textarea
                id="mcp-description"
                value={mcpDraft.description}
                onChange={(e) => setMcpDraft((c) => ({ ...c, description: e.target.value }))}
                placeholder="What capability boundary does this server expose?"
                rows={2}
                readOnly={Boolean(inheritedServer)}
              />
            </div>

            <details className="rounded-md border border-outline-variant p-3">
              <summary className="cursor-pointer text-sm font-medium text-on-surface">Advanced settings</summary>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-server-id">Server ID</Label>
                  <Input
                    id="mcp-server-id"
                    value={mcpDraft.serverId}
                    onChange={(e) => setMcpDraft((c) => ({ ...c, serverId: e.target.value, customId: true, routePath: c.customRoute ? c.routePath : `/mcp/${e.target.value}` }))}
                    disabled={Boolean(editingMcpServerId)}
                    required
                  />
                </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-mode">Mode</Label>
                <Select
                  value={mcpDraft.mode}
                  disabled={Boolean(inheritedServer)}
                  onValueChange={(v) =>
                    setMcpDraft((c) => ({ ...c, mode: v as McpDraft["mode"] }))
                  }
                >
                  <SelectTrigger id="mcp-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="managed">Managed</SelectItem>
                    <SelectItem value="proxy">Proxy</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-route">Route path</Label>
                <Input
                  id="mcp-route"
                  value={mcpDraft.routePath}
                  onChange={(e) => setMcpDraft((c) => ({ ...c, routePath: e.target.value, customRoute: true }))}
                  placeholder="/mcp/example"
                  required
                  readOnly={Boolean(inheritedServer)}
                />
              </div>
            </div>
            </details>

            {mcpDraft.mode === "proxy" && !inheritedServer ? (
              <div className="space-y-4">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Account for this connection</legend>
                  <label className="flex items-center gap-2 text-sm"><input type="radio" name="mcp-credential-scope" checked={mcpDraft.credentialScope === "organization"} onChange={() => setMcpDraft((current) => ({ ...current, credentialScope: "organization", upstreamAuthSecret: "" }))} />Organization account</label>
                  <label className="flex items-center gap-2 text-sm"><input type="radio" name="mcp-credential-scope" checked={mcpDraft.credentialScope === "personal"} onChange={() => setMcpDraft((current) => ({ ...current, credentialScope: "personal", upstreamAuthSecret: "" }))} />Each member connects</label>
                  <p className="text-xs text-on-surface-variant">Members use their own credentials when this connection is available to them. Changing the URL or authentication method requires members to reconnect.</p>
                </fieldset>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-upstream-auth-type">Upstream authentication</Label>
                  <Select
                    value={mcpDraft.upstreamAuthType}
                    onValueChange={(value) =>
                      setMcpDraft((current) => ({
                        ...current,
                        upstreamAuthType: value as McpDraft["upstreamAuthType"],
                        upstreamAuthName:
                          value === "header" || value === "query"
                            ? current.upstreamAuthName
                            : "",
                        upstreamAuthSecret: value === "none" ? "" : current.upstreamAuthSecret
                      }))
                    }
                  >
                    <SelectTrigger id="mcp-upstream-auth-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                      <SelectItem value="header">Custom header</SelectItem>
                      <SelectItem value="query">Query parameter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {mcpDraft.upstreamAuthType === "header" ||
                mcpDraft.upstreamAuthType === "query" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-upstream-auth-name">
                      {mcpDraft.upstreamAuthType === "header" ? "Header name" : "Parameter name"}
                    </Label>
                    <Input
                      id="mcp-upstream-auth-name"
                      value={mcpDraft.upstreamAuthName}
                      onChange={(event) =>
                        setMcpDraft((current) => ({
                          ...current,
                          upstreamAuthName: event.target.value
                        }))
                      }
                      placeholder={mcpDraft.upstreamAuthType === "header" ? "X-API-Key" : "api_key"}
                    />
                  </div>
                ) : null}

                {mcpDraft.credentialScope === "organization" && mcpDraft.upstreamAuthType !== "none" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-upstream-auth-secret">Secret</Label>
                    <Input
                      id="mcp-upstream-auth-secret"
                      type="password"
                      autoComplete="new-password"
                      value={mcpDraft.upstreamAuthSecret}
                      onChange={(event) =>
                        setMcpDraft((current) => ({
                          ...current,
                          upstreamAuthSecret: event.target.value
                        }))
                      }
                      placeholder={
                        editingMcpServerId && mcpDraft.upstreamAuthSecret === ""
                          ? "Leave blank to keep the existing secret"
                          : "Upstream credential"
                      }
                    />
                  </div>
                ) : null}
                </div>
                {mcpDraft.credentialScope === "personal" && mcpDraft.upstreamAuthType === "none" ? <p role="alert" className="text-sm text-danger">Choose bearer token, header, or query authentication so each member can connect.</p> : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-audience">Availability</Label>
                <Select value={mcpDraft.audience} onValueChange={(value) => setMcpDraft((current) => ({ ...current, audience: value as McpAudience }))}>
                  <SelectTrigger id="mcp-audience" className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    {!inheritedServer || !inheritedServer.isPublished ? <SelectItem value="test_users">Test users</SelectItem> : null}
                    {!inheritedServer || inheritedServer.isPublished ? <SelectItem value="members">All members</SelectItem> : null}
                  </SelectContent>
                </Select>
                <p className="text-xs text-on-surface-variant">
                  {inheritedServer
                    ? "This built-in connection is managed by the system. You can change its tenant availability."
                    : "Test users can use this before it is available to all members."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" disabled={props.busyKey === "mcp" || (mcpDraft.mode === "proxy" && mcpDraft.credentialScope === "personal" && mcpDraft.upstreamAuthType === "none") || (mcpDraft.mode === "proxy" && mcpDraft.credentialScope === "organization" && mcpDraft.upstreamAuthType !== "none" && !mcpDraft.upstreamAuthSecret && (!editingMcpServerId || props.mcpServers.find((server) => server.serverId === editingMcpServerId)?.credentialScope === "personal"))}>
                  {inheritedServer ? "Save availability" : editingMcpServerId ? "Save connection" : "Add connection"}
                </Button>
              </div>
            </div>
            {props.saveError ? <p role="alert" className="text-sm text-danger">{props.saveError}</p> : null}
          </form>
  ) : null;
  const targetMissing = Boolean(props.targetServerId) && !props.mcpServers.some((server) => server.serverId === props.targetServerId);

  return (
    <section aria-labelledby="mcp-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="mcp-heading" className="text-lg font-semibold text-on-surface">MCP connections</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={showForm && !editingMcpServerId}
          aria-controls="mcp-add-form"
          onClick={() => {
            setShowForm(!(showForm && !editingMcpServerId));
            setEditingMcpServerId(null);
            setMcpDraft(emptyMcpDraft);
          }}
        >
          {showForm && !editingMcpServerId ? "Cancel" : "Add connection"}
        </Button>
      </div>
      {targetMissing ? <p role="alert" className="mt-2 text-sm text-on-surface-variant">This connection is no longer available. Choose a connection below.</p> : null}
      <div id="mcp-add-form" hidden={!(showForm && !editingMcpServerId)} className="mt-4">{showForm && !editingMcpServerId ? form : null}</div>

      <div className="mt-2 divide-y divide-outline-variant border-t border-outline-variant">
        {props.mcpServers.length === 0 ? <p className="py-4 text-sm text-on-surface-variant">No connections yet.</p> : null}
        {props.mcpServers.map((server) => {
          const availability = getMcpAvailability(server);
          const editing = showForm && editingMcpServerId === server.serverId;
          const unsavedChanges = editing && JSON.stringify(mcpDraft) !== JSON.stringify(draftForServer(server));
          const check = server.connectionTest;
          const tested = check && check.configVersion === server.version && check.configHash === server.configHash
            && (server.credentialScope !== "personal" || check.testedUserId === user?.userId);
          return (
            <DisclosureRow
              key={server.serverId}
              title={server.serverName}
              status={<>{availability.label}.{availability.blocker ? <span className="text-warning"> {availability.blocker}</span> : null}{" "}
                {tested ? `Last test: ${reachabilityLabel[check.reachability].toLowerCase()}.` : "Not tested since the last save."}</>}
              action="Manage"
              actionLabel={`Manage ${server.serverName}`}
              open={expandedId === server.serverId}
              disabled={props.busyKey !== null}
              onOpenChange={(next) => {
                if (next) { setExpandedId(server.serverId); handleEdit(server); }
                else { setExpandedId(null); if (editing) handleCancel(); }
              }}
            >
              {editing ? form : <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => handleEdit(server)} disabled={props.busyKey !== null}>Edit settings</Button>}
              <div className="flex flex-wrap gap-2 text-xs text-on-surface-variant">
                <span className={CHIP}>ID {server.serverId}</span>
                <span className={CHIP}>route {server.routePath}</span>
                <span className={CHIP}>version {server.version}</span>
                <span className={CHIP}>{server.mode} · {server.transportKind}</span>
                <span className={CHIP}>authentication {server.credentialScope === "personal" || server.upstreamAuthConfigured ? server.upstreamAuthType : "none"}</span>
                {server.mode === "proxy" ? <span className={CHIP}>{server.credentialScope === "personal" ? "Each member connects" : "Organization account"}</span> : null}
                <span className={CHIP} title="Distinct sessions in the last 30 days where this server received a tool call.">Used in {server.invokedSessions30d ?? 0} sessions</span>
                <span className={CHIP} title="Distinct sessions in the last 30 days where this server was offered to the agent.">Offered in {server.materializedSessions30d ?? 0} sessions</span>
              </div>
              <AdminMcpConnectionTestCard key={`${server.serverId}:${server.version}:${server.configHash}`} server={server} listGeneration={props.listGeneration ?? 0} unsavedChanges={unsavedChanges} onTested={props.onTested} onReload={props.onReload} />
              {props.renderServerExtras?.(server, expandedId === server.serverId)}
            </DisclosureRow>
          );
        })}
      </div>
    </section>
  );
}
