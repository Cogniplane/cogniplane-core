"use client";

import { FormEvent } from "react";
import type { SkillMarketplaceCatalog, SkillMarketplaceEntry } from "@cogniplane/shared-types";
import type { SkillReadState } from "@/hooks/use-admin-skills-data";
import { formatMarketplaceDate, getMarketplaceReviewPillClass } from "./admin-skill-card-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

export function AdminSkillMarketplaceTab(props: {
  marketplace: SkillMarketplaceCatalog | null;
  manifestUrl: string | null | undefined;
  manifestUrlDraft: string;
  busyKey: string | null;
  catalogState?: SkillReadState;
  manifestState?: SkillReadState;
  manifestChanged?: boolean;
  error?: string;
  manifestError?: string;
  onManifestUrlDraftChange: (value: string) => void;
  onSaveManifestUrl: (event: FormEvent<HTMLFormElement>) => void;
  onClearManifestUrl: () => void;
  onImportMarketplace: (entry: SkillMarketplaceEntry) => Promise<void>;
}) {
  const catalog = props.catalogState;
  const manifest = props.manifestState;
  const manifestUnknown = props.manifestUrl === undefined || Boolean(manifest && ["pending", "failed", "unavailable", "stale"].includes(manifest.status));
  const saving = props.busyKey === "skill-marketplace-manifest-url";
  const catalogOutdated = Boolean(catalog && ["failed", "unavailable", "stale", "pending"].includes(catalog.status));

  return <div className="flex min-w-0 flex-col gap-5 px-1 py-2">
    <details className="min-w-0 border-b border-outline-variant pb-4">
      <summary className="cursor-pointer text-sm font-medium text-on-surface">Marketplace configuration</summary>
      <div className="mt-3 space-y-3">
        <p className="break-words text-sm text-on-surface-variant [overflow-wrap:anywhere]">Saved organization override: {props.manifestUrl === undefined ? "not loaded" : props.manifestUrl ?? "none. The deployment default applies."}</p>
        {manifest?.status === "pending" ? <p role="status" className="text-sm text-on-surface-variant">Loading saved manifest URL...</p> : null}
        {manifest?.error || manifest?.status === "unavailable" ? <p role="alert" className="text-sm text-danger">{manifest.error ?? "Saved manifest URL unavailable."}{manifest.status === "stale" ? " The last loaded value is shown. Reload it before saving." : ""}</p> : null}
        {manifest ? <Button type="button" size="sm" variant="outline" disabled={manifest.refreshing || saving} onClick={manifest.retry}>{manifest.refreshing ? "Loading saved URL..." : manifestUnknown ? "Retry saved URL" : "Refresh saved URL"}</Button> : null}
        <form onSubmit={props.onSaveManifestUrl} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="marketplace-manifest-url">Marketplace manifest URL</Label>
            <Input id="marketplace-manifest-url" type="url" pattern="https://.*" maxLength={2048} autoComplete="off"
              disabled={manifestUnknown} aria-describedby="marketplace-manifest-help"
              placeholder="https://example.com/marketplace.json" value={props.manifestUrlDraft}
              onChange={event => props.onManifestUrlDraftChange(event.target.value)} />
          </div>
          {props.manifestChanged ? <p role="status" className="text-sm text-warning">The saved URL changed. Your unsaved URL is kept above. Compare it with the saved value before saving.</p> : null}
          <p id="marketplace-manifest-help" className="text-xs text-on-surface-variant">Use a public HTTPS marketplace.json file. This overrides the deployment default for this organization. Saving a non-empty URL requires identity confirmation and notifies owners. Clearing restores the deployment default.</p>
          {props.manifestError ? <p role="alert" className="text-sm text-danger">{props.manifestError}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={manifestUnknown || props.busyKey !== null || props.manifestUrlDraft.trim() === (props.manifestUrl ?? "")}>{saving ? "Saving..." : "Save manifest URL"}</Button>
            {props.manifestUrl ? <Button type="button" variant="outline" disabled={manifestUnknown || props.busyKey !== null} onClick={props.onClearManifestUrl}>Clear</Button> : null}
          </div>
        </form>
      </div>
    </details>

    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-on-surface">Curated skills</h3>
      {catalog ? <Button type="button" size="sm" variant="outline" disabled={catalog.refreshing || saving} onClick={catalog.retry}>{catalog.refreshing ? "Loading marketplace..." : catalogOutdated || props.marketplace?.status === "error" ? "Retry marketplace" : "Refresh marketplace"}</Button> : null}
    </div>
    {(!props.marketplace && (!catalog || catalog.status === "pending")) ? <p role="status" className="text-sm text-on-surface-variant">Loading curated skills...</p> : null}
    {catalog?.error || catalog?.status === "unavailable" ? <p role="alert" className="text-sm text-danger">{catalog.error ?? "Marketplace unavailable."}{catalog.status === "stale" ? " Showing the last loaded catalog. Refresh before importing." : ""}</p> : null}
    {props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}

    {props.marketplace?.status === "ready" ? <>
      <p className="text-xs text-on-surface-variant">{props.marketplace.skills.length} curated{props.marketplace.fetchedAt ? ` · refreshed ${formatMarketplaceDate(props.marketplace.fetchedAt) ?? "date unavailable"}` : ""}</p>
      {props.marketplace.skills.length === 0 ? <p className="text-sm text-on-surface-variant">This catalog has no skills. Try another import source or refresh the catalog.</p> : null}
      <div className="divide-y divide-outline-variant">
        {props.marketplace.skills.map(entry => {
          const importing = props.busyKey === `skill-import-marketplace-${entry.slug}`;
          const reviewedAt = formatMarketplaceDate(entry.lastReviewedAt);
          return <article key={entry.slug} className="min-w-0 space-y-3 py-4 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h4 className="min-w-0 break-words text-sm font-semibold text-on-surface">{entry.name}</h4>
              <div className="flex flex-wrap gap-1.5">
                <span className={cn(getMarketplaceReviewPillClass(entry.reviewStatus), "rounded px-1.5 text-xs font-medium normal-case tracking-normal")}>{entry.reviewStatus}</span>
                {entry.recommended ? <span className="rounded bg-success-surface px-1.5 py-0.5 text-xs font-medium text-success">recommended</span> : null}
              </div>
            </div>
            <p className="break-all text-xs text-on-surface-variant">{entry.slug}</p>
            <p className="text-sm text-on-surface-variant">{entry.description}</p>
            <dl className="grid min-w-0 gap-x-3 gap-y-1 text-xs text-on-surface-variant sm:grid-cols-[auto_1fr]">
              <dt>Repository</dt><dd className="break-all">{entry.repositoryUrl}</dd>
              <dt>Ref</dt><dd className="break-all font-mono">{entry.ref}</dd>
              <dt>Subdirectory</dt><dd className="break-all font-mono">{entry.subdirectory || "Repository root"}</dd>
            </dl>
            <div className="flex flex-wrap gap-1.5 text-xs text-on-surface-variant">
              {entry.publisher ? <span>{entry.publisher}</span> : null}
              {entry.skillVersion ? <span>skill v{entry.skillVersion}</span> : null}
              {reviewedAt ? <span>reviewed {reviewedAt}</span> : null}
              {entry.tags.map(tag => <span key={tag} className="break-all rounded bg-surface-container px-1.5 py-0.5">{tag}</span>)}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {entry.sourceUrl ? <Button asChild variant="outline" size="sm"><a href={entry.sourceUrl} rel="noreferrer" target="_blank">View source</a></Button> : null}
              <Button type="button" size="sm" disabled={props.busyKey !== null || catalogOutdated} onClick={() => void props.onImportMarketplace(entry).catch(() => undefined)}>{importing ? "Importing..." : "Import skill"}</Button>
            </div>
          </article>;
        })}
      </div>
    </> : null}
    {props.marketplace?.status === "disabled" ? <p className="text-sm text-on-surface-variant">No marketplace manifest is configured yet. Set an organization override above or ask an owner about the deployment default. You can also use GitHub, ZIP upload, or Paste SKILL.md.</p> : null}
    {props.marketplace?.status === "error" ? <div className="space-y-1"><p role="alert" className="text-sm text-danger">{props.marketplace.error}</p>{props.marketplace.sourceUrl ? <p className="break-all text-xs text-on-surface-variant">{props.marketplace.sourceUrl}</p> : null}</div> : null}
  </div>;
}
