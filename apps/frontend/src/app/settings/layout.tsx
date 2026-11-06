"use client";

import { usePathname } from "next/navigation";
import { useMemo, type ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsoleNavigation } from "../../components/console-navigation";
import { ConsolePageHeader } from "../../components/console-page-header";
import { useEnabledSettingsSections } from "../../hooks/use-enabled-settings-sections";
import { useSettingsOverviewData } from "../../hooks/use-settings-overview-data";
import { useSkillUpdates } from "../../hooks/use-skill-updates";
import { useAuth } from "../../lib/auth-context";

// Frontend overlay attachment. The private build registers overlay settings
// sections here; the OSS build's stub is empty. Import is for side effect
// only — the file's *contents* are what differs between builds.
import "../../overlays";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { liveSections, navigationItems: filteredNavigationItems } =
    useEnabledSettingsSections();
  // Compare the whole first segment, so that `/settings/jira-x` does not
  // select `jira`. Nested pages such as `/settings/scheduled-jobs/<id>` keep
  // their section.
  const segment = /^\/settings\/([^/?#]+)/.exec(pathname)?.[1];
  const activeSection =
    liveSections.find((item) => item.id === segment) ??
    liveSections.find((item) => item.id === "connections");
  const activeSectionId = activeSection?.kind === "integration" ? "connections" : (activeSection?.id ?? "connections");

  const { scheduledJobsCount } = useSettingsOverviewData();
  const { user } = useAuth();
  const updates = useSkillUpdates(user ? { tenantId: user.tenantId, userId: user.userId } : null);

  const navigationItems = useMemo(
    () =>
      filteredNavigationItems.map((item) => {
        if (item.id === "scheduled-jobs") return { ...item, count: scheduledJobsCount };
        if (item.id === "skill-updates") return { ...item, count: updates.isError ? undefined : updates.data?.unreadCount || undefined };
        return item;
      }),
    [filteredNavigationItems, scheduledJobsCount, updates.data?.unreadCount, updates.isError]
  );

  return (
    <AuthGuard>
      <main className="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] bg-background md:grid-rows-1 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <ConsoleNavigation
          sectionLabel="Settings"
          ariaLabel="Settings sections"
          activeSectionId={activeSectionId}
          navigationItems={navigationItems}
          basePath="/settings"
        />

        <div className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-10 pt-4 md:px-8 md:pt-6">
          <ConsolePageHeader
            title={activeSection?.title ?? activeSection?.label ?? "Connected accounts"}
            subtitle={activeSection?.subtitle}
            destinations={["chat", "artifacts", "admin"]}
          />

          {children}
        </div>
      </main>
    </AuthGuard>
  );
}
