"use client";

import { useAdminMcpData } from "../../../hooks/use-admin-mcp-data";
import { AdminMcpCard } from "./admin-mcp-card";
import { AdminMcpWidgetDomains } from "./admin-mcp-widget-domains";
import { Button } from "../../ui/button";

export function AdminMcpContent({ targetServerId = null }: { targetServerId?: string | null }) {
  const {
    mcpServers,
    listGeneration,
    loading,
    loaded,
    reload,
    busyKey,
    loadError,
    saveError,
    handleSubmit,
    handleSetInheritedAudience
  } = useAdminMcpData();

  return (
    <section id="mcp" className="flex flex-col gap-5">
      {loading ? <p role="status" className="text-sm text-on-surface-variant">Loading connections…</p> : null}
      {loadError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger"><p>{loadError}</p><Button type="button" variant="outline" size="sm" onClick={() => void reload()}>Reload</Button></div> : null}
      {loaded ? <AdminMcpCard
        key={`${targetServerId ?? ""}:${mcpServers.some((server) => server.serverId === targetServerId)}`}
        targetServerId={targetServerId}
        mcpServers={mcpServers}
        listGeneration={listGeneration}
        busyKey={busyKey}
        saveError={saveError}
        onSubmit={handleSubmit}
        onSetInheritedAudience={handleSetInheritedAudience}
        onTested={() => { void reload(); }}
        onReload={() => { void reload(); }}
        // Only a proxy connection serves a view that declares its own domains.
        renderServerExtras={(server, open) => server.mode === "proxy"
          ? <AdminMcpWidgetDomains key={server.serverId} server={server} open={open} />
          : null}
      /> : null}
    </section>
  );
}
