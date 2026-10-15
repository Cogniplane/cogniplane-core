"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAdminOrganizationData } from "../../../hooks/use-admin-organization-data";
import { AdminPiiDashboard } from "../../../components/admin/pii/admin-pii-dashboard";
import { AdminPiiProtectionSection } from "../../../components/admin/pii/admin-pii-protection-section";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type PrivacyTab = "settings" | "activity";

function PrivacySettings() {
  const { tenant, tenantLoading, tenantLoadError, retryTenantLoad, mutationError, errorKey, busyKey, successMessage, successKey, handleSavePiiProtection } =
    useAdminOrganizationData();

  return (
    <section id="privacy" className="flex flex-col gap-5 pt-5">
      {!tenant && tenantLoading ? <p role="status" className="text-sm text-on-surface-variant">Loading privacy settings...</p> : null}
      {!tenant && tenantLoadError ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-danger">{tenantLoadError}</p>
          <Button type="button" variant="outline" onClick={() => void retryTenantLoad()}>Retry</Button>
        </div>
      ) : null}
      {tenant ? (
        <AdminPiiProtectionSection
          busy={busyKey === "save-pii-protection"}
          error={errorKey === "save-pii-protection" ? mutationError : null}
          savedMessage={successKey === "save-pii-protection" ? successMessage : null}
          onSave={handleSavePiiProtection}
          value={tenant.settings.piiProtection}
        />
      ) : null}
    </section>
  );
}

function PrivacyTabs() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab: PrivacyTab = params.get("tab") === "activity" ? "activity" : "settings";
  // Activity loads its dashboard on the first visit only. After that both panels
  // stay mounted, so an unsaved settings draft and the chosen range survive a switch.
  const [activityVisited, setActivityVisited] = useState(tab === "activity");
  if (tab === "activity" && !activityVisited) setActivityVisited(true);

  const selectTab = (value: string) => {
    if (value === tab) return;
    const next = new URLSearchParams(params.toString());
    if (value === "activity") next.set("tab", "activity");
    else next.delete("tab");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <Tabs value={tab} onValueChange={selectTab} className="pt-5">
      <TabsList aria-label="Privacy views">
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="settings" forceMount hidden={tab !== "settings"}>
        <PrivacySettings />
      </TabsContent>
      <TabsContent value="activity" forceMount hidden={tab !== "activity"}>
        {activityVisited ? <AdminPiiDashboard /> : null}
      </TabsContent>
    </Tabs>
  );
}

export default function AdminPrivacyPage() {
  return (
    <Suspense fallback={<p role="status" className="pt-5 text-sm text-on-surface-variant">Loading privacy...</p>}>
      <PrivacyTabs />
    </Suspense>
  );
}
