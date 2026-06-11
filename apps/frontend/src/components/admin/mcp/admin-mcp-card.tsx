"use client";

import { FormEvent, useState } from "react";

import type { AdminMcpServer } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { PILL_GRAY, PILL_GREEN, LIST_ITEM, SECTION_LABEL } from "../../../lib/ui-tokens";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

type McpDraft = {
  serverId: string;
  serverName: string;
  description: string;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string;
  headersAllowlist: string;
  enabled: boolean;
};

const emptyMcpDraft: McpDraft = {
  serverId: "",
  serverName: "",
  description: "",
  mode: "managed",
  routePath: "/mcp/",
  upstreamUrl: "",
  headersAllowlist: "",
  enabled: true
};

function toCsv(values: string[]): string {
  return values.join(", ");
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function AdminMcpCard(props: {
  mcpServers: AdminMcpServer[];
  busyKey: string | null;
  onSubmit: (
    input: {
      serverId: string;
      serverName: string;
      description: string | null;
      mode: "managed" | "proxy";
      routePath: string;
      upstreamUrl: string | null;
      headersAllowlist: string[];
      enabled: boolean;
    },
    editingId: string | null
  ) => Promise<void>;
  onDisable: (serverId: string) => void;
  onPublish: (serverId: string) => void;
  onUnpublish: (serverId: string) => void;
}) {
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(emptyMcpDraft);
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function handleCancel() {
    setShowForm(false);
    setEditingMcpServerId(null);
    setMcpDraft(emptyMcpDraft);
  }

  function handleEdit(server: AdminMcpServer) {
    setEditingMcpServerId(server.serverId);
    setMcpDraft({
      serverId: server.serverId,
      serverName: server.serverName,
      description: server.description ?? "",
      mode: server.mode,
      routePath: server.routePath,
      upstreamUrl: server.upstreamUrl ?? "",
      headersAllowlist: toCsv(server.headersAllowlist),
      enabled: server.enabled
    });
    setShowForm(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      await props.onSubmit(
        {
          serverId: mcpDraft.serverId,
          serverName: mcpDraft.serverName,
          description: mcpDraft.description || null,
          mode: mcpDraft.mode,
          routePath: mcpDraft.routePath,
          upstreamUrl: mcpDraft.upstreamUrl || null,
          headersAllowlist: parseCsv(mcpDraft.headersAllowlist),
          enabled: mcpDraft.enabled
        },
        editingMcpServerId
      );
      setEditingMcpServerId(null);
      setMcpDraft(emptyMcpDraft);
      setShowForm(false);
    } catch {
      return;
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Gateway</p>
            <h2 className="text-lg font-semibold text-on-surface">MCP infrastructure</h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              Register managed or proxied servers, set path routing, and keep inbound headers
              under explicit control.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={PILL_GRAY}>{props.mcpServers.length} total</span>
            <span className={PILL_GRAY}>
              {props.mcpServers.filter((s) => s.enabled).length} enabled
            </span>
            <Button
              type="button"
              onClick={() => {
                setShowForm((v) => !v);
                setEditingMcpServerId(null);
                setMcpDraft(emptyMcpDraft);
              }}
            >
              {showForm && !editingMcpServerId ? "Cancel" : "New server"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {showForm ? (
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface-container-low p-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-server-id">Server ID</Label>
                <Input
                  id="mcp-server-id"
                  value={mcpDraft.serverId}
                  onChange={(e) => setMcpDraft((c) => ({ ...c, serverId: e.target.value }))}
                  placeholder="server-id"
                  disabled={Boolean(editingMcpServerId)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-server-name">Server name</Label>
                <Input
                  id="mcp-server-name"
                  value={mcpDraft.serverName}
                  onChange={(e) => setMcpDraft((c) => ({ ...c, serverName: e.target.value }))}
                  placeholder="Server name"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-description">Description</Label>
              <Textarea
                id="mcp-description"
                value={mcpDraft.description}
                onChange={(e) => setMcpDraft((c) => ({ ...c, description: e.target.value }))}
                placeholder="What capability boundary does this server expose?"
                rows={2}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-mode">Mode</Label>
                <Select
                  value={mcpDraft.mode}
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
                  onChange={(e) => setMcpDraft((c) => ({ ...c, routePath: e.target.value }))}
                  placeholder="/mcp/example"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-upstream">Upstream URL</Label>
                <Input
                  id="mcp-upstream"
                  value={mcpDraft.upstreamUrl}
                  onChange={(e) => setMcpDraft((c) => ({ ...c, upstreamUrl: e.target.value }))}
                  placeholder="https://example.com/mcp"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-headers">Header allowlist</Label>
              <Input
                id="mcp-headers"
                value={mcpDraft.headersAllowlist}
                onChange={(e) =>
                  setMcpDraft((c) => ({ ...c, headersAllowlist: e.target.value }))
                }
                placeholder="X-Header-One, X-Header-Two"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={mcpDraft.enabled}
                  onChange={(e) =>
                    setMcpDraft((c) => ({ ...c, enabled: e.target.checked }))
                  }
                  className="size-4 rounded border-outline-variant accent-primary"
                />
                <span>Enabled</span>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" disabled={props.busyKey === "mcp"}>
                  {editingMcpServerId ? "Update server" : "Create server"}
                </Button>
              </div>
            </div>
          </form>
        ) : null}

        <div className="flex flex-col gap-2">
          {props.mcpServers.map((server) => (
            <div className={`${LIST_ITEM} flex flex-col gap-3 sm:flex-row sm:justify-between`} key={server.serverId}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-semibold text-on-surface">
                    {server.serverName}
                  </strong>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={PILL_GRAY}>{server.mode}</span>
                    <span className={server.enabled ? PILL_GREEN : PILL_GRAY}>
                      {server.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className={server.isPublished ? PILL_GREEN : PILL_GRAY}>
                      {server.isPublished ? "published" : "draft"}
                    </span>
                    <span
                      className={PILL_GRAY}
                      title="Distinct sessions in the last 30 days where this MCP server received a JSON-RPC tool call."
                    >
                      Used {server.invokedSessions30d ?? 0}
                    </span>
                    <span
                      className={PILL_GRAY}
                      title="Distinct sessions in the last 30 days where this MCP server was offered to the agent (regardless of whether it was used)."
                    >
                      Available {server.materializedSessions30d ?? 0}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-on-surface-faint">
                  {server.serverId} · route {server.routePath} · v{server.version}
                </p>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {server.description ?? "No description"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={CHIP}>transport {server.transportKind}</span>
                  {server.upstreamUrl ? <span className={CHIP}>proxy upstream</span> : null}
                  {server.headersAllowlist.length ? (
                    <span className={CHIP}>
                      {server.headersAllowlist.length} forwarded headers
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
                <Button type="button" variant="outline" size="sm" onClick={() => handleEdit(server)}>
                  Edit
                </Button>
                {server.isPublished ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => props.onUnpublish(server.serverId)}
                  >
                    Unpublish
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => props.onPublish(server.serverId)}
                  >
                    Publish
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => props.onDisable(server.serverId)}
                >
                  Disable
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
