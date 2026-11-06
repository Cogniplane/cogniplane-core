"use client";

import { Suspense } from "react";
import { AuthGuard } from "@/lib/auth-guard";
import { Projects } from "@/components/projects-page";

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p role="status" className="p-6">Loading projects...</p>}>
        <Projects />
      </Suspense>
    </AuthGuard>
  );
}
