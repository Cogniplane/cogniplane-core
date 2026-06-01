"use client";

import { Suspense } from "react";

import { ArtifactBrowser } from "../../components/artifact-browser";

// Client page (matches the /settings convention) — no `dynamic` route-segment
// config here. ArtifactBrowser reads useSearchParams, which Next 16 requires be
// wrapped in a Suspense boundary.
export default function ArtifactsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-on-surface-faint">Loading…</p>}>
      <ArtifactBrowser />
    </Suspense>
  );
}
