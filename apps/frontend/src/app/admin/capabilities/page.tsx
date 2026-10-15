"use client";

import { LastAdminChange } from "../../../components/admin/history/history-widgets";

import { useQuery } from "@tanstack/react-query";

import { TenantSettingsForm } from "../../../components/tenant-settings-form";
import { Button } from "../../../components/ui/button";
import { modelAvailabilityWarning } from "../../../components/tenant-settings-form.logic";
import { useModelPreference } from "../../../hooks/use-model-preference";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";
import {
  getAdminModelCatalog,
  listAdminManagedTools
} from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";
import { useAuth } from "../../../lib/auth-context";

export default function AdminAgentSettingsPage() {
  const { user } = useAuth();
  const { settings, saving, loadError, saveError, save, reload } = useTenantSettings();
  const { model } = useModelPreference();

  const managedToolsQuery = useQuery({
    queryKey: queryKeys.admin.managedTools(),
    queryFn: listAdminManagedTools
  });

  const modelCatalogQuery = useQuery({
    queryKey: queryKeys.models.adminCatalog(),
    queryFn: getAdminModelCatalog
  });

  // The catalog decides the warning, so say why it is missing rather than
  // letting an unresolved or failed fetch read as "your model is fine".
  const checking = modelCatalogQuery.isPending || modelCatalogQuery.isFetching;

  return (
    <section id="capabilities" className="flex flex-col gap-5 pt-5">
      {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}
      {!settings && !loadError ? <p role="status">Loading agent settings...</p> : null}
      {managedToolsQuery.isError ? <p role="alert" className="text-sm text-danger">Could not load the tool catalog. <Button variant="outline" onClick={() => void managedToolsQuery.refetch()}>Retry tools</Button></p> : null}
      {checking ? <p role="status">Checking model availability...</p> : null}
      {modelCatalogQuery.isError && !checking ? (
        <div className="flex flex-col items-start gap-2">
          <p role="status">Could not check model availability.</p>
          <Button type="button" variant="outline"
            onClick={() => { void modelCatalogQuery.refetch(); }}>
            Retry model check
          </Button>
        </div>
      ) : null}
      {settings ? (
        <TenantSettingsForm
          settings={settings}
          saving={saving}
          onSave={save}
          saveError={saveError}
          onReload={() => void reload()}
          managedTools={managedToolsQuery.data ?? []}
          modelWarning={modelCatalogQuery.isSuccess
            ? modelAvailabilityWarning(model, modelCatalogQuery.data, settings)
            : null}
          isOwner={user?.role === "owner"}
          meta={<LastAdminChange section="agent" />}
        />
      ) : null}
    </section>
  );
}
