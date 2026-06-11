"use client";

import { FormEvent } from "react";

import {
  formatMarketplaceDate,
  getMarketplaceReviewPillClass
} from "./admin-skill-card-utils";
import type { SkillMarketplaceCatalog, SkillMarketplaceEntry } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminSkillMarketplaceTab(props: {
  marketplace: SkillMarketplaceCatalog | null;
  manifestUrl: string | null;
  manifestUrlDraft: string;
  busyKey: string | null;
  onManifestUrlDraftChange: (value: string) => void;
  onSaveManifestUrl: (event: FormEvent<HTMLFormElement>) => void;
  onClearManifestUrl: () => void;
  onImportMarketplace: (entry: SkillMarketplaceEntry) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4 px-1 py-2">
      <form onSubmit={props.onSaveManifestUrl} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="marketplace-manifest-url">Marketplace manifest URL</Label>
          <Input
            id="marketplace-manifest-url"
            type="url"
            autoComplete="off"
            placeholder="https://example.com/marketplace.json"
            value={props.manifestUrlDraft}
            onChange={(e) => props.onManifestUrlDraftChange(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            disabled={
              props.busyKey === "skill-marketplace-manifest-url"
              || props.manifestUrlDraft.trim() === (props.manifestUrl ?? "")
            }
          >
            {props.busyKey === "skill-marketplace-manifest-url" ? "Saving..." : "Save manifest URL"}
          </Button>
          {props.manifestUrl ? (
            <Button
              type="button"
              variant="outline"
              disabled={props.busyKey === "skill-marketplace-manifest-url"}
              onClick={props.onClearManifestUrl}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-on-surface-variant">
          Points to a public <code className="font-mono">marketplace.json</code> file. When set,
          it overrides the deployment-wide{" "}
          <code className="font-mono">SKILL_MARKETPLACE_MANIFEST_URL</code> for this organization.
        </p>
      </form>

      <div className="h-px bg-outline-variant" />

      {!props.marketplace && (
        <p className="text-sm text-on-surface-variant">Loading curated skills...</p>
      )}

      {props.marketplace?.status === "ready" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
              {props.marketplace.skills.length} curated
            </span>
            {props.marketplace.repositoryUrl ? (
              <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                public GitHub catalog
              </span>
            ) : null}
            {props.marketplace.fetchedAt ? (
              <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                refreshed {formatMarketplaceDate(props.marketplace.fetchedAt) ?? "today"}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {props.marketplace.skills.map((entry) => {
              const busyKey = `skill-import-marketplace-${entry.slug}`;
              const reviewedAt = formatMarketplaceDate(entry.lastReviewedAt);
              return (
                <div
                  key={entry.slug}
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <strong className="text-sm font-semibold text-on-surface">{entry.name}</strong>
                    <div className="flex flex-wrap gap-1.5">
                      <span className={getMarketplaceReviewPillClass(entry.reviewStatus)}>
                        {entry.reviewStatus}
                      </span>
                      {entry.recommended ? (
                        <span className="rounded bg-success-surface px-1.5 py-0.5 text-xs font-semibold text-success">
                          recommended
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mb-1 text-xs text-on-surface-faint">{entry.slug}</p>
                  <p className="mb-2 text-sm text-on-surface-variant">{entry.description}</p>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {entry.publisher ? (
                      <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                        {entry.publisher}
                      </span>
                    ) : null}
                    {entry.skillVersion ? (
                      <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                        skill v{entry.skillVersion}
                      </span>
                    ) : null}
                    <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                      {entry.ref.slice(0, 12)}
                    </span>
                    <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                      {entry.subdirectory}
                    </span>
                    {reviewedAt ? (
                      <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                        reviewed {reviewedAt}
                      </span>
                    ) : null}
                    {entry.tags.map((tag) => (
                      <span
                        key={`${entry.slug}-${tag}`}
                        className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    {entry.sourceUrl ? (
                      <Button asChild variant="outline" size="sm">
                        <a href={entry.sourceUrl} rel="noreferrer" target="_blank">
                          View source
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={props.busyKey === busyKey}
                      onClick={() => void props.onImportMarketplace(entry)}
                    >
                      {props.busyKey === busyKey ? "Importing..." : "Import skill"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {props.marketplace?.status === "disabled" && (
        <p className="text-sm text-on-surface-variant">
          No marketplace manifest is configured yet. Set the URL above, or configure a
          deployment-wide <code className="font-mono">SKILL_MARKETPLACE_MANIFEST_URL</code>.
        </p>
      )}

      {props.marketplace?.status === "error" && (
        <>
          <p className="text-sm text-danger">{props.marketplace.error}</p>
          {props.marketplace.sourceUrl ? (
            <p className="text-xs text-on-surface-variant">{props.marketplace.sourceUrl}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
