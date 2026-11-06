"use client";

import type { ReactNode } from "react";

import { AuthGuard } from "../../lib/auth-guard";
import { ConsolePageHeader } from "../../components/console-page-header";

export default function ArtifactsLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <main className="min-h-screen bg-background">
        <ConsolePageHeader
          className="mx-auto w-full max-w-6xl px-4 pt-4 md:px-8 md:pt-6"
          title="Artifacts"
          subtitle="Browse, preview, and download files across all your sessions."
          destinations={["chat", "settings", "admin"]}
        />
        <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-4 md:px-8 md:pt-6">{children}</div>
      </main>
    </AuthGuard>
  );
}
