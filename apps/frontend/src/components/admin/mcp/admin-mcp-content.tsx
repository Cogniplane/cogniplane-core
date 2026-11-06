"use client";

import { useEffect, useRef, useState } from "react";
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
    handleSubmit,
    handleSetInheritedAudience
  } = useAdminMcpData();
  const heading = useRef<HTMLHeadingElement>(null);
  const reloadPending = useRef(false);
  const reloadOwnedFocus = useRef(false);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (!reloading && reloadOwnedFocus.current) {
      if (document.activeElement === document.body) heading.current?.focus();
      reloadOwnedFocus.current = false;
    }
  }, [reloading]);

  async function reloadConnections(trigger: HTMLButtonElement) {
    if (reloadPending.current) return;
    reloadPending.current = true;
    reloadOwnedFocus.current = document.activeElement === trigger;
    setReloading(true);
    try { await reload(); }
    finally { reloadPending.current = false; setReloading(false); }
  }

  return (
    <section id="mcp" className="flex flex-col gap-5">
      <AdminMcpCard
        headingRef={heading}
        listReady={loaded}
        listNotice={<>
          {loading && !reloading ? <p role="status" className="mt-3 text-sm text-on-surface-variant">Loading connections…</p> : null}
          {loadError || reloading ? (
            <div className="mt-3 flex flex-col items-start gap-3 text-sm">
              <Button type="button" variant="outline" size="sm" className="min-w-28" aria-disabled={reloading} aria-busy={reloading} onClick={event => void reloadConnections(event.currentTarget)}>{reloading ? "Reloading…" : "Reload"}</Button>
              <p role={reloading ? "status" : "alert"} className={reloading ? "text-on-surface-variant" : "text-danger"}>{reloading ? `${loaded ? "Showing saved results. " : ""}Reloading the connection list…` : loaded ? `Showing saved results. Refresh failed. ${loadError}` : loadError}</p>
            </div>
          ) : null}
        </>}
        targetServerId={targetServerId}
        mcpServers={mcpServers}
        listGeneration={listGeneration}
        busyKey={busyKey}
        onSubmit={handleSubmit}
        onSetInheritedAudience={handleSetInheritedAudience}
        onTested={() => { void reload(); }}
        onReload={reload}
        // Only a proxy connection serves a view that declares its own domains.
        renderServerExtras={(server, open) => server.mode === "proxy"
          ? <AdminMcpWidgetDomains key={server.serverId} server={server} open={open} />
          : null}
      />
    </section>
  );
}
