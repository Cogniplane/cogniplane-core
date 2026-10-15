"use client";

import { useEffect, useMemo, useState } from "react";

import { useAdminIntegrations } from "../../../hooks/use-integrations";
import { AdminIntegrationRow } from "./admin-integration-row";
import { AdminIntegrationPane } from "./admin-integration-pane";
import { HINT } from "../../../lib/ui-tokens";

export function AdminIntegrationsList() {
  const {
    integrations,
    isLoading,
    activeId,
    error,
    configError,
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
      <h2 id="integrations-heading" className="text-lg font-semibold text-on-surface">Built-in integrations</h2>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {flashMessage ? <p className={HINT}>{flashMessage}</p> : null}

      {isLoading ? (
        <p className={HINT}>Loading integrations...</p>
      ) : available.length === 0 ? (
        <p className={HINT}>No integrations available yet.</p>
      ) : (
        <div className="divide-y divide-outline-variant border-t border-outline-variant">
          {available.map((integration) => (
            <AdminIntegrationRow
              key={integration.id}
              integration={integration}
              busy={activeId === integration.id}
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
          busy={activeId === openIntegration.id}
          error={configError?.integrationId === openIntegration.id ? configError.message : null}
          onClose={() => setOpenId(null)}
          onSaveConfig={async (config) => {
            await update(openIntegration.id, { config });
          }}
          onClearConfig={async () => {
            await clearConfig(openIntegration.id);
          }}
        />
      ) : null}
    </section>
  );
}
