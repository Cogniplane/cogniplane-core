import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { ssrfSafeAgent } from "../../lib/url-validation.js";

const marketplaceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const reviewStatusSchema = z.enum(["official", "reviewed", "community", "experimental"]);

const marketplaceEntrySchema = z.object({
  slug: marketplaceSlugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1024),
  repoUrl: z.string().url().optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  subdirectory: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine(
      (value) => !value.startsWith("/") && value !== "." && !value.split("/").includes(".."),
      "subdirectory must stay within the repository root."
    ),
  publisher: z.string().trim().min(1).max(120).optional(),
  reviewStatus: reviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(16).optional(),
  recommended: z.boolean().optional(),
  skillVersion: z.string().trim().min(1).max(64).optional(),
  lastReviewedAt: z.string().datetime().optional(),
  sourceUrl: z.string().url().optional()
});

const marketplaceManifestSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(1024).optional(),
  repositoryUrl: z.string().url().optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  skills: z.array(marketplaceEntrySchema).max(250)
});

export type SkillMarketplaceEntry = {
  slug: string;
  name: string;
  description: string;
  repositoryUrl: string;
  ref: string;
  subdirectory: string;
  publisher: string | null;
  reviewStatus: z.infer<typeof reviewStatusSchema>;
  tags: string[];
  recommended: boolean;
  skillVersion: string | null;
  lastReviewedAt: string | null;
  sourceUrl: string | null;
};

export type SkillMarketplaceCatalog =
  | {
      status: "disabled";
      sourceUrl: string | null;
      title: string;
      description: string | null;
      repositoryUrl: string | null;
      fetchedAt: string | null;
      error: string | null;
      skills: SkillMarketplaceEntry[];
    }
  | {
      status: "error";
      sourceUrl: string;
      title: string;
      description: string | null;
      repositoryUrl: string | null;
      fetchedAt: string;
      error: string;
      skills: SkillMarketplaceEntry[];
    }
  | {
      status: "ready";
      sourceUrl: string;
      title: string;
      description: string | null;
      repositoryUrl: string | null;
      fetchedAt: string;
      error: null;
      skills: SkillMarketplaceEntry[];
    };

function buildDisabledCatalog(manifestUrl: string | undefined): SkillMarketplaceCatalog {
  return {
    status: "disabled",
    sourceUrl: manifestUrl ?? null,
    title: "Reviewed Agent Skills",
    description: "Configure a public marketplace manifest to surface recommended Agent Skills during onboarding.",
    repositoryUrl: null,
    fetchedAt: null,
    error: null,
    skills: []
  };
}

function deriveGitHubTreeUrl(repositoryUrl: string, ref: string, subdirectory: string): string | null {
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname !== "github.com") {
      return null;
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }

    return `https://github.com/${pathParts[0]}/${pathParts[1]}/tree/${encodeURIComponent(ref)}/${subdirectory}`;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Unable to load the marketplace manifest.";
}

function shouldSendGithubToken(manifestUrl: string): boolean {
  try {
    const hostname = new URL(manifestUrl).hostname.toLowerCase();
    return hostname === "github.com" ||
      hostname === "api.github.com" ||
      hostname === "raw.githubusercontent.com";
  } catch {
    return false;
  }
}

export class SkillMarketplaceService {
  private cachedCatalog: SkillMarketplaceCatalog | null = null;
  private cachedAt = 0;
  private inFlight: Promise<SkillMarketplaceCatalog> | null = null;

  constructor(
    private readonly config: Pick<
      AppConfig,
      "SKILL_MARKETPLACE_MANIFEST_URL" | "SKILL_MARKETPLACE_CACHE_TTL_MS"
    >,
    private readonly fetchImpl: typeof fetch = undiciFetch as unknown as typeof fetch
  ) {}

  async getCatalog(opts?: { manifestUrl?: string; githubToken?: string }): Promise<SkillMarketplaceCatalog> {
    const overrideUrl = opts?.manifestUrl;

    // Org-specific URL: bypass cache, fetch with token
    if (overrideUrl) {
      return this.loadCatalog(overrideUrl, opts?.githubToken);
    }

    // Platform-wide URL: existing caching logic
    if (!this.config.SKILL_MARKETPLACE_MANIFEST_URL) {
      return buildDisabledCatalog(undefined);
    }

    const now = Date.now();
    if (
      this.cachedCatalog &&
      now - this.cachedAt < this.config.SKILL_MARKETPLACE_CACHE_TTL_MS
    ) {
      return this.cachedCatalog;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.loadCatalog(this.config.SKILL_MARKETPLACE_MANIFEST_URL).finally(() => {
      this.inFlight = null;
    });

    const catalog = await this.inFlight;
    this.cachedCatalog = catalog;
    this.cachedAt = now;
    return catalog;
  }

  private async loadCatalog(manifestUrl: string, githubToken?: string): Promise<SkillMarketplaceCatalog> {
    const fetchedAt = new Date().toISOString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "cogniplane-core"
    };
    if (githubToken && shouldSendGithubToken(manifestUrl)) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    try {
      // dispatcher pins the connection to the pre-validated resolved IP,
      // closing the DNS-rebinding TOCTOU window between tenant-time URL
      // validation (httpsUrlSchema) and this on-demand fetch. Must reach
      // undici's fetch directly — Node's global fetch ignores `dispatcher`
      // as of undici v8 (the default fetchImpl is undici.fetch for this
      // reason); the cast keeps the dispatcher field through the wider type.
      const response = await (this.fetchImpl as unknown as typeof undiciFetch)(manifestUrl, {
        headers,
        dispatcher: ssrfSafeAgent
      });

      if (!response.ok) {
        throw new Error(`Marketplace manifest request failed with status ${response.status}.`);
      }

      const rawPayload = await response.json();
      const manifest = marketplaceManifestSchema.parse(rawPayload);

      const normalizedSkills = manifest.skills.map((entry) => {
        const repositoryUrl = entry.repoUrl ?? manifest.repositoryUrl;
        const ref = entry.ref ?? manifest.ref;

        if (!repositoryUrl) {
          throw new Error(`Marketplace skill ${entry.slug} is missing repoUrl or repositoryUrl.`);
        }

        if (!ref) {
          throw new Error(`Marketplace skill ${entry.slug} is missing ref.`);
        }

        return {
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          repositoryUrl,
          ref,
          subdirectory: entry.subdirectory,
          publisher: entry.publisher ?? null,
          reviewStatus: entry.reviewStatus ?? "reviewed",
          tags: entry.tags ?? [],
          recommended: entry.recommended ?? false,
          skillVersion: entry.skillVersion ?? null,
          lastReviewedAt: entry.lastReviewedAt ?? null,
          sourceUrl:
            entry.sourceUrl ??
            deriveGitHubTreeUrl(repositoryUrl, ref, entry.subdirectory)
        } satisfies SkillMarketplaceEntry;
      });

      return {
        status: "ready",
        sourceUrl: manifestUrl,
        title: manifest.title ?? "Reviewed Agent Skills",
        description:
          manifest.description ??
          "Import curated Agent Skills bundles into the internal registry for tenant-local review and activation.",
        repositoryUrl: manifest.repositoryUrl ?? null,
        fetchedAt,
        error: null,
        skills: normalizedSkills
      };
    } catch (error) {
      return {
        status: "error",
        sourceUrl: manifestUrl,
        title: "Reviewed Agent Skills",
        description: null,
        repositoryUrl: null,
        fetchedAt,
        error: errorMessage(error),
        skills: []
      };
    }
  }
}
