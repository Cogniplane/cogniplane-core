"use client";

import { useAdminOrganizationData } from "../../../hooks/use-admin-organization-data";
import { useAuth } from "../../../lib/auth-context";
import { AdminOrganizationCard } from "../../../components/admin-organization-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

export default function AdminOrganizationPage() {
  const { user } = useAuth();
  const {
    tenant,
    busyKey,
    error,
    successMessage,
    successKey,
    handleSaveApiKey,
    handleSaveAnthropicKey
  } = useAdminOrganizationData();
  const pageError = error;
  const openaiSuccessMessage = successKey === "save-api-key" ? successMessage : null;
  const anthropicSuccessMessage = successKey === "save-anthropic-key" ? successMessage : null;
  const resolvedTenantName = user?.tenantName ?? tenant?.tenantName ?? "Unknown";
  const resolvedTenantSlug = user?.tenantSlug ?? tenant?.slug ?? "Unknown";

  return (
    <section id="organization" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Configuration</p>
        <h3 className="text-lg font-semibold text-on-surface">Organization</h3>
      </div>
      <Card>
        <CardHeader>
          <p className={SECTION_LABEL}>Current Workspace</p>
          <h2 className="text-lg font-semibold text-on-surface">{resolvedTenantName}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            Authenticated tenant context for this admin session.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className={LIST_ITEM}>
              <strong className="text-sm font-semibold text-on-surface">tenantName</strong>
              <p className="mt-1 text-xs text-on-surface-faint">{resolvedTenantName}</p>
            </div>
            <div className={LIST_ITEM}>
              <strong className="text-sm font-semibold text-on-surface">tenantSlug</strong>
              <p className="mt-1 text-xs text-on-surface-faint">{resolvedTenantSlug}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      {pageError ? <p className="text-sm text-danger">{pageError}</p> : null}
      <AdminOrganizationCard
        tenant={tenant}
        busyKey={busyKey}
        openaiSuccessMessage={openaiSuccessMessage}
        anthropicSuccessMessage={anthropicSuccessMessage}
        onSaveApiKey={handleSaveApiKey}
        onSaveAnthropicKey={handleSaveAnthropicKey}
      />
    </section>
  );
}
