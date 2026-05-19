"use client";

import { usePathname } from "next/navigation";
import { useMemo, type ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsoleNavigation } from "../../components/console-navigation";
import { ConsolePageHeader } from "../../components/console-page-header";
import { useEnabledSettingsSections } from "../../hooks/use-enabled-settings-sections";
import { useSettingsOverviewData } from "../../hooks/use-settings-overview-data";

// Frontend overlay attachment. Private build registers the SharePoint
// settings section here; OSS build's stub is empty. Import is for side
// effect only — the file's *contents* are what differs between builds.
import "../../overlays";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { liveSections, navigationItems: filteredNavigationItems } =
    useEnabledSettingsSections();
  const activeSection =
    liveSections.find((item) => pathname.startsWith(`/settings/${item.id}`)) ??
    liveSections.find((item) => item.id === "overview");
  const activeSectionId = activeSection?.id ?? "overview";

  const { scheduledJobsCount } = useSettingsOverviewData();

  const navigationItems = useMemo(
    () =>
      filteredNavigationItems.map((item) => {
        if (item.id === "scheduled-jobs") return { ...item, count: scheduledJobsCount };
        return item;
      }),
    [filteredNavigationItems, scheduledJobsCount]
  );

  return (
    <AuthGuard>
      <main className="grid min-h-screen grid-cols-1 bg-background md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <ConsoleNavigation
          sectionLabel="Settings"
          ariaLabel="Settings sections"
          activeSectionId={activeSectionId}
          navigationItems={navigationItems}
          basePath="/settings"
        />

        <div className="min-w-0 px-4 pb-10 pt-4 md:px-8 md:pt-6">
          <ConsolePageHeader
            eyebrow="Settings"
            title={activeSection?.title ?? activeSection?.label ?? "User preferences"}
            subtitle={activeSection?.subtitle}
            menuLinks={[
              { href: "/", label: "Chat", description: "Return to the active workspace" },
              { href: "/admin", label: "Admin", description: "Open platform control plane" }
            ]}
          />

          {children}
        </div>
      </main>
    </AuthGuard>
  );
}
