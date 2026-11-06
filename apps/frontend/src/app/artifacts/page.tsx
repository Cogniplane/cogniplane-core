"use client";

import { Suspense } from "react";

import { ArtifactBrowser } from "../../components/artifact-browser";

// ArtifactBrowser reads URL filters inside a client Suspense boundary.
export default function ArtifactsPage() {
  return (
    <Suspense fallback={<p role="status" className="text-sm text-on-surface-variant">Loading artifacts…</p>}>
      <ArtifactBrowser />
    </Suspense>
  );
}
