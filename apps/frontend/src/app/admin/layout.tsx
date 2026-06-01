"use client";

import { usePathname } from "next/navigation";
import { useMemo, type ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsoleNavigation } from "../../components/console-navigation";
import { ConsolePageHeader } from "../../components/console-page-header";
import { useAdminOverviewData } from "../../hooks/use-admin-overview-data";
import { ADMIN_LIVE_SECTIONS, ADMIN_NAVIGATION_ITEMS } from "./admin-sections";

const ADMIN_SECTION_TITLES: Record<string, { title: string; subtitle: string }> = {
  overview: {
    title: "Control plane",
    subtitle: "Design the operating surface for the runtime, not just a config form."
  },
  privacy: {
    title: "Privacy",
    subtitle: "PII detection and transformation policy applied before the runtime sees user content."
  },
  organization: { title: "Organization", subtitle: "Tenant profile and platform defaults." },
  skills: { title: "Skills", subtitle: "Manage the skill library exposed to the runtime." },
  mcp: { title: "MCP servers", subtitle: "Register and configure gateway routes." },
  integrations: {
    title: "Integrations",
    subtitle: "Enable third-party services for your tenant. Users connect their own accounts after you toggle an integration on."
  },
  capabilities: { title: "Agent settings", subtitle: "Tune tools, approvals, and guardrails per profile." },
  policy: {
    title: "Policy Center",
    subtitle: "Risk-adaptive rules for agent tool actions, a simulator, and recent decisions."
  },
  runtime: { title: "Runtime rollout", subtitle: "Control provider selection and runtime configuration." },
  users: { title: "Users", subtitle: "Members, roles, and access management." },
  sessions: { title: "Sessions", subtitle: "Review and investigate chat sessions across the tenant." },
  "token-usage": { title: "Token usage", subtitle: "Consumption across the tenant." },
  "message-feedback": { title: "Message feedback", subtitle: "Ratings and notes from conversations." }
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeSectionId =
    ADMIN_LIVE_SECTIONS.find((item) => pathname.startsWith(`/admin/${item.id}`))?.id ?? "overview";

  const { skillsCount, mcpServersCount } = useAdminOverviewData();

  const navigationItems = useMemo(
    () =>
      ADMIN_NAVIGATION_ITEMS.map((item) => {
        if (item.id === "skills") return { ...item, count: skillsCount };
        if (item.id === "mcp") return { ...item, count: mcpServersCount };
        return item;
      }),
    [skillsCount, mcpServersCount]
  );

  return (
    <AuthGuard requiredRoles={["admin", "owner"]}>
      <main className="grid min-h-screen grid-cols-1 bg-background md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <ConsoleNavigation
          sectionLabel="Admin"
          ariaLabel="Admin sections"
          activeSectionId={activeSectionId}
          navigationItems={navigationItems}
          basePath="/admin"
        />

        <div className="min-w-0 px-4 pb-10 pt-4 md:px-8 md:pt-6">
          <ConsolePageHeader
            eyebrow="Admin"
            title={ADMIN_SECTION_TITLES[activeSectionId]?.title ?? "Control plane"}
            subtitle={ADMIN_SECTION_TITLES[activeSectionId]?.subtitle}
            menuLinks={[
              { href: "/", label: "Chat", description: "Return to the live workspace" },
              { href: "/artifacts", label: "Artifacts", description: "Browse files across all sessions" },
              { href: "/settings", label: "Settings", description: "Open user preferences and jobs" }
            ]}
          />

          {children}
        </div>
      </main>
    </AuthGuard>
  );
}
