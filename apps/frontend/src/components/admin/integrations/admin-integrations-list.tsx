"use client";

import { useEffect, useMemo, useState } from "react";

import { useAdminIntegrations } from "../../../hooks/use-integrations";
import { AdminIntegrationRow } from "./admin-integration-row";
import { AdminIntegrationPane } from "./admin-integration-pane";
import { Button } from "../../ui/button";
import { HINT } from "../../../lib/ui-tokens";

export function AdminIntegrationsList() {
  const {
    integrations,
    isLoading,
    hasData,
    isRefreshing,
    loadError,
    pending,
    errors,
    isPending,
    reload,
    flashMessage,
    update,
    clearConfig
  } = useAdminIntegrations();

  const [openId, setOpenId] = useState<string | null>(null);

  // A "#integrations" link scrolls before the lists above have loaded. Scroll again once they have.
  useEffect(() => {
    if (!isLoading && window.location.hash === "#integrations") {
      document.getElementById("integrations")?.scrollIntoView?.({ block: "start" });
    }
  }, [isLoading]);

  const sorted = useMemo(
    () => [...integrations].sort((a, b) => a.name.localeCompare(b.name)),
    [integrations]
  );

  const available = sorted.filter((entry) => entry.status !== "coming_soon");
  const planned = sorted.filter((entry) => entry.status === "coming_soon");

  const openIntegration = openId
    ? sorted.find((entry) => entry.id === openId) ?? null
    : null;

  return (
    <section id="integrations" aria-labelledby="integrations-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="integrations-heading" className="text-lg font-semibold text-on-surface">Built-in integrations</h2>
        <Button type="button" variant="outline" size="sm" aria-disabled={isRefreshing || Object.keys(pending).length > 0}
          onClick={() => { if (!isRefreshing) reload(); }}>{loadError ? "Retry integrations" : "Reload integrations"}</Button>
      </div>
      <div role="status" className={HINT}>
        {isRefreshing && hasData ? "Refreshing integrations. Showing the last loaded list." : flashMessage}
      </div>
      {loadError ? <div role="alert" className="text-sm text-danger">
        <p>{hasData ? "Could not refresh integrations. Showing the last loaded list." : "Could not load integrations."}</p>
        <p>{loadError} Use Retry integrations to try again.</p>
      </div> : null}

      {isLoading ? (
        <p className={HINT}>Loading integrations...</p>
      ) : !hasData ? null : available.length === 0 ? (
        <p className={HINT}>{loadError ? "The last loaded list had no available integrations." : "No integrations available yet."}</p>
      ) : (
        <div className="divide-y divide-outline-variant border-t border-outline-variant">
          {available.map((integration) => (
            <AdminIntegrationRow
              key={integration.id}
              integration={integration}
              busy={Boolean(pending[integration.id])}
              operation={pending[integration.id]}
              error={errors[integration.id]?.operation === "toggle" ? errors[integration.id]?.message : undefined}
              onOpen={() => setOpenId(integration.id)}
              onToggleReads={(next) => void update(integration.id, { readsEnabled: next })}
              onToggleWrites={(next) => void update(integration.id, { writesEnabled: next })}
            />
          ))}
        </div>
      )}

      {planned.length ? (
        <p className={HINT}>Coming soon: {planned.map((integration) => integration.name).join(", ")}.</p>
      ) : null}

      {openIntegration ? (
        <AdminIntegrationPane
          integration={openIntegration}
          busy={Boolean(pending[openIntegration.id])}
          operation={pending[openIntegration.id]}
          errorOperation={errors[openIntegration.id]?.operation}
          error={errors[openIntegration.id]?.operation !== "toggle" ? errors[openIntegration.id]?.message ?? null : null}
          onClose={() => { if (!isPending(openIntegration.id)) setOpenId(null); }}
          onSaveConfig={async (config) => {
            return update(openIntegration.id, { config });
          }}
          onClearConfig={async () => {
            return clearConfig(openIntegration.id);
          }}
        />
      ) : null}
    </section>
  );
}
