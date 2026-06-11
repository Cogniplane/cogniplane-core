"use client";

import { useAdminOrganizationData } from "../../../hooks/use-admin-organization-data";
import { AdminPiiProtectionSection } from "../../../components/admin/pii/admin-pii-protection-section";
import { Card, CardContent } from "@/components/ui/card";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminPrivacyPage() {
  const { tenant, busyKey, error, successMessage, handleSavePiiProtection } =
    useAdminOrganizationData();

  return (
    <section id="privacy" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Configuration</p>
        <h3 className="text-lg font-semibold text-on-surface">Privacy</h3>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {successMessage ? <p className="text-sm text-on-surface-faint">{successMessage}</p> : null}
      <Card>
        <CardContent className="pt-6">
          <AdminPiiProtectionSection
            busy={busyKey === "save-pii-protection"}
            onSave={handleSavePiiProtection}
            value={tenant?.settings.piiProtection ?? null}
          />
        </CardContent>
      </Card>
    </section>
  );
}
