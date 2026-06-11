"use client";

import { useMemo, useState } from "react";

import { useAdminIntegrations } from "../../../hooks/use-integrations";
import { AdminIntegrationRow } from "./admin-integration-row";
import { AdminIntegrationPane } from "./admin-integration-pane";
import { HINT, SECTION_LABEL } from "../../../lib/ui-tokens";

export function AdminIntegrationsList() {
  const {
    integrations,
    isLoading,
    activeId,
    error,
    flashMessage,
    update,
    clearConfig
  } = useAdminIntegrations();

  const [openId, setOpenId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...integrations].sort((a, b) => a.name.localeCompare(b.name)),
    [integrations]
  );

  const openIntegration = openId
    ? sorted.find((entry) => entry.id === openId) ?? null
    : null;

  return (
    <section id="integrations" className="flex flex-col gap-4">
      <div>
        <p className={SECTION_LABEL}>Connected services</p>
        <h3 className="text-lg font-semibold text-on-surface">Integrations</h3>
        <p className={`${HINT} mt-1`}>
          Toggle reads and writes per integration. Users connect their own accounts after you
          enable an integration here.
        </p>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {flashMessage ? <p className={HINT}>{flashMessage}</p> : null}

      {isLoading ? (
        <p className={HINT}>Loading integrations...</p>
      ) : sorted.length === 0 ? (
        <p className={HINT}>No integrations available.</p>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
          {sorted.map((integration) => (
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

      {openIntegration ? (
        <AdminIntegrationPane
          integration={openIntegration}
          busy={activeId === openIntegration.id}
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
