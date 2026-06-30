"use client";

import { useQuery } from "@tanstack/react-query";

import { TenantSettingsForm } from "../../../components/tenant-settings-form";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";
import {
  getTenantDetails,
  listAdminManagedTools,
  listAdminMcpServers
} from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";
import { useAuth } from "../../../lib/auth-context";

export default function AdminAgentSettingsPage() {
  const { user } = useAuth();
  const { settings, saving, error, save } = useTenantSettings();

  const managedToolsQuery = useQuery({
    queryKey: queryKeys.admin.managedTools(),
    queryFn: listAdminManagedTools
  });

  const mcpServersQuery = useQuery({
    queryKey: queryKeys.admin.mcpServers(),
    queryFn: listAdminMcpServers
  });

  const tenantDetailsQuery = useQuery({
    queryKey: queryKeys.admin.tenant(),
    queryFn: getTenantDetails
  });

  return (
    <section id="capabilities" className="flex flex-col gap-5">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {settings ? (
        <TenantSettingsForm
          settings={settings}
          saving={saving}
          onSave={save}
          managedTools={managedToolsQuery.data ?? []}
          mcpServers={mcpServersQuery.data ?? []}
          openaiKeyConfigured={Boolean(tenantDetailsQuery.data?.settings.openaiApiKeyConfigured)}
          anthropicKeyConfigured={Boolean(
            tenantDetailsQuery.data?.settings.anthropicApiKeyConfigured
          )}
          isOwner={user?.role === "owner"}
        />
      ) : null}
    </section>
  );
}
