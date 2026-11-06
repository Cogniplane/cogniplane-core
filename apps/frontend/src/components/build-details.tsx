"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useAuth } from "../lib/auth-context";
import { getBackendBuild, type BackendBuild } from "../lib/admin-api";

/** Build identifiers are available in help when someone needs support. */
export function BuildDetails() {
  const { user } = useAuth();
  const canSeeBackendBuild = user?.role === "admin" || user?.role === "owner";
  const [build, setBuild] = useState<BackendBuild | null>(null);
  useEffect(() => {
    if (!canSeeBackendBuild) return;
    let cancelled = false;
    getBackendBuild().then((value) => { if (!cancelled) setBuild(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [canSeeBackendBuild]);
  const frontendSha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";
  const frontendDate = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";
  const backendBuild = canSeeBackendBuild ? build : null;

  return (
    <details className="group border-t border-outline-variant pt-3 text-xs text-on-surface-variant">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Build details
      </summary>
      <dl className="mt-2 space-y-2">
        <div><dt>Frontend</dt><dd className="break-all font-mono" title={`Frontend: ${frontendSha} · ${frontendDate}`}>fe · {frontendSha.slice(0, 7)}{frontendDate ? ` · ${frontendDate.slice(0, 10)}` : ""}</dd></div>
        {backendBuild ? <div><dt>Backend</dt><dd className="break-all font-mono" title={`Backend: ${backendBuild.sha} · ${backendBuild.buildDate}`}>be · {backendBuild.sha.slice(0, 7)}{backendBuild.buildDate ? ` · ${backendBuild.buildDate.slice(0, 10)}` : ""}</dd></div> : null}
      </dl>
    </details>
  );
}
