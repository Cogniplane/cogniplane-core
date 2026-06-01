"use client";

import type { ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsolePageHeader } from "../../components/console-page-header";

export default function ArtifactsLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <main className="min-h-screen bg-background">
        <ConsolePageHeader
          eyebrow="Workspace"
          title="Artifacts"
          subtitle="Browse, preview, and download files across all your sessions."
          menuLinks={[
            { href: "/", label: "Chat", description: "Return to the active workspace" },
            { href: "/settings", label: "Settings", description: "User preferences and connectors" },
            { href: "/admin", label: "Admin", description: "Open platform control plane" }
          ]}
        />
        <div className="px-4 pb-10 pt-4 md:px-8 md:pt-6">{children}</div>
      </main>
    </AuthGuard>
  );
}
