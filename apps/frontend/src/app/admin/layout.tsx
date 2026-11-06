"use client";

import { usePathname } from "next/navigation";
import { useMemo, useRef, type ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsoleNavigation } from "../../components/console-navigation";
import { ConsolePageHeader } from "../../components/console-page-header";
import { useAdminOverviewData } from "../../hooks/use-admin-overview-data";
import { ADMIN_NAVIGATION_ITEMS, adminSectionForPath, type AdminSectionId } from "./admin-sections";

const ADMIN_SECTION_TITLES: Record<AdminSectionId, { title: string; subtitle?: string }> = {
  overview: { title: "Overview" },
  models: { title: "Models", subtitle: "Set up providers, choose available models, and set the organization default." },
  connections: { title: "Connections", subtitle: "Manage connections and who can use them. Members connect their own accounts for built-in services." },
  privacy: {
    title: "Privacy",
    subtitle: "Choose whether personal data is detected, blocked, or redacted before the agent uses it, and review scan results."
  },
  skills: { title: "Skills", subtitle: "Review, release, and limit the skills people can use." },
  capabilities: { title: "Agent behavior", subtitle: "Set approvals, command execution, built-in tools, and organization instructions." },
  policy: {
    title: "Policies",
    subtitle: "Write rules for agent tool actions, test them in the simulator, and review recent decisions."
  },
  runtime: { title: "Runtime diagnostics", subtitle: "Check runtime sessions and backend keys, and refresh or drain idle sessions." },
  users: { title: "People", subtitle: "See what each person does and manage their role and access." },
  "project-owners": { title: "Project owners", subtitle: "Find projects that have no owner and choose a new one. This gives you no access to project content." },
  history: { title: "Change history", subtitle: "See who changed what and compare recorded settings." },
  sessions: { title: "Sessions", subtitle: "Review and investigate chat sessions across the organization." },
  "token-usage": { title: "Usage", subtitle: "Model budget and token consumption across the organization." },
  "message-feedback": { title: "Message feedback", subtitle: "Ratings and notes from conversations." }
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  const content = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const activeSectionId = adminSectionForPath(pathname);

  const { skillsCount, mcpServersCount } = useAdminOverviewData();

  const navigationItems = useMemo(
    () =>
      ADMIN_NAVIGATION_ITEMS.map((item) => {
        if (item.id === "skills") return { ...item, count: skillsCount };
        if (item.id === "connections") return { ...item, count: mcpServersCount };
        return item;
      }),
    [skillsCount, mcpServersCount]
  );

  return (
    <AuthGuard requiredRoles={["admin", "owner"]}>
      <a
        href="#admin-content"
        onClick={() => content.current?.focus()}
        className="sr-only rounded-md bg-background text-sm font-medium text-on-surface outline-none focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:px-4 focus:py-2 focus:ring-[3px] focus:ring-ring/50"
      >
        Skip to content
      </a>
      <div className="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] bg-background md:grid-rows-1 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <ConsoleNavigation
          sectionLabel="Admin"
          ariaLabel="Admin sections"
          activeSectionId={activeSectionId}
          navigationItems={navigationItems}
          basePath="/admin"
        />

        <main
          id="admin-content"
          ref={content}
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-6xl scroll-mt-2 rounded-sm px-4 pb-10 pt-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:px-8 md:pt-6"
        >
          <ConsolePageHeader
            title={ADMIN_SECTION_TITLES[activeSectionId].title}
            subtitle={ADMIN_SECTION_TITLES[activeSectionId].subtitle}
            destinations={["chat", "artifacts", "settings"]}
          />

          {children}
        </main>
      </div>
    </AuthGuard>
  );
}
