/**
 * Server-proxied, cached view of OpenRouter's PUBLIC models catalog
 * (https://openrouter.ai/api/v1/models — no API key required). Feeds the
 * admin "add custom model" picker and validates submitted slugs, so the
 * browser never talks to OpenRouter directly and the URL is fixed (no SSRF
 * surface). Cached in-process; the catalog changes rarely.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type OpenRouterCatalogEntry = {
  /** OpenRouter slug, e.g. "moonshotai/kimi-k3" (used as vendorModelId). */
  id: string;
  name: string;
  contextLength: number | null;
};

export type OpenRouterCatalogFetcher = () => Promise<OpenRouterCatalogEntry[]>;

export function buildOpenRouterCatalogFetcher(options?: {
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}): OpenRouterCatalogFetcher {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  let cache: { at: number; entries: OpenRouterCatalogEntry[] } | null = null;
  let inflight: Promise<OpenRouterCatalogEntry[]> | null = null;

  const load = async (): Promise<OpenRouterCatalogEntry[]> => {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`OpenRouter models API responded ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { id?: unknown; name?: unknown; context_length?: unknown }[];
    };
    const entries: OpenRouterCatalogEntry[] = (body.data ?? [])
      .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
      .map((entry) => ({
        id: entry.id as string,
        name: typeof entry.name === "string" && entry.name ? entry.name : (entry.id as string),
        contextLength:
          typeof entry.context_length === "number" && entry.context_length > 0
            ? Math.floor(entry.context_length)
            : null
      }));
    if (entries.length === 0) {
      throw new Error("OpenRouter models API returned an empty catalog");
    }
    return entries;
  };

  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.entries;
    // Collapse concurrent misses into one upstream request.
    inflight ??= load()
      .then((entries) => {
        cache = { at: Date.now(), entries };
        return entries;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
