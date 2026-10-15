export type ProxyToolMetadata = {
  name: string;
  _meta?: { ui?: { resourceUri?: unknown } } | null;
  annotations?: {
    readOnlyHint?: boolean;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

/** One `tools/list` response, as far as this cache cares about it. */
export type ProxyToolListPage = {
  /** The `params.cursor` the runtime sent. Absent/null starts a fresh listing. */
  requestCursor?: string | null;
  /** The `result.nextCursor` the upstream returned. Absent/null ends the listing. */
  nextCursor?: string | null;
  tools: readonly ProxyToolMetadata[];
};

type StagedListing = {
  tools: Map<string, CachedToolMetadata>;
  /** The cursor the next page of this listing must carry. */
  expectedCursor: string;
};

type ServerEntry = {
  /** Last complete listing. Only this is ever read by `isReadOnly`. */
  published: Map<string, CachedToolMetadata>;
  /** In-flight listings, isolated by the runtime token that initiated them. */
  staged: Map<string, StagedListing>;
};

type CachedToolMetadata = { readOnly: boolean; resourceUri: string | null };

export const MAX_PROXY_TOOL_METADATA_SCOPES = 512;

function readOnlyOf(tool: ProxyToolMetadata): boolean {
  return tool.annotations?.readOnlyHint === true;
}

function appResourceUriOf(tool: ProxyToolMetadata): string | null {
  const uri = tool._meta?.ui?.resourceUri;
  return typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 2048 ? uri : null;
}

/**
 * Per-tenant, per-server, per-credential map of proxy tool metadata.
 *
 * A `tools/list` sequence is treated as authoritative: a listing that starts
 * with no cursor and runs to a page with no `nextCursor` REPLACES the server's
 * whole map, so a tool the upstream has removed (or replaced with a mutating
 * tool of the same name in a later listing) stops being served as read-only.
 *
 * Until that final page lands, pages accumulate into a per-listing staging map
 * that nothing reads. Any failure simply skips `recordToolsPage`, so the
 * previous complete listing keeps serving. A continuation page must match both
 * the listing id and the cursor issued to that listing. Orphan pages are ignored.
 */
export class ProxyToolMetadataCache {
  // Keyed by tenantId -> [serverId, credential scope]
  private readonly cache = new Map<string, Map<string, ServerEntry>>();
  private readonly scopeOrder = new Map<string, { tenantId: string; serverKey: string }>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly missingUntil = new Map<string, number>();

  constructor(private readonly logger?: { warn(meta: object, message: string): void }) {}

  private key(serverId: string, scope: string): string {
    return JSON.stringify([serverId, scope]);
  }

  private touch(tenantId: string, serverKey: string): void {
    const scopeKey = JSON.stringify([tenantId, serverKey]);
    this.scopeOrder.delete(scopeKey);
    this.scopeOrder.set(scopeKey, { tenantId, serverKey });
    if (this.scopeOrder.size <= MAX_PROXY_TOOL_METADATA_SCOPES) return;
    const oldest = this.scopeOrder.keys().next().value;
    if (oldest === undefined) return;
    const evicted = this.scopeOrder.get(oldest)!;
    this.scopeOrder.delete(oldest);
    const tenantMap = this.cache.get(evicted.tenantId);
    tenantMap?.delete(evicted.serverKey);
    if (tenantMap?.size === 0) this.cache.delete(evicted.tenantId);
  }

  private published(tenantId: string, serverId: string, scope: string): Map<string, CachedToolMetadata> | undefined {
    const serverKey = this.key(serverId, scope);
    const entry = this.cache.get(tenantId)?.get(serverKey);
    if (entry) this.touch(tenantId, serverKey);
    return entry?.published;
  }

  private entry(tenantId: string, serverId: string, scope: string): ServerEntry {
    let tenantMap = this.cache.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map<string, ServerEntry>();
      this.cache.set(tenantId, tenantMap);
    }
    const key = this.key(serverId, scope);
    let serverEntry = tenantMap.get(key);
    if (!serverEntry) {
      serverEntry = { published: new Map<string, CachedToolMetadata>(), staged: new Map() };
      tenantMap.set(key, serverEntry);
    }
    this.touch(tenantId, key);
    return serverEntry;
  }

  /**
   * Record one successful `tools/list` page. Call this only for a successful
   * response with a valid `tools` array — never on an error.
   */
  recordToolsPage(
    tenantId: string,
    serverId: string,
    listingId: string,
    page: ProxyToolListPage,
    scope = ""
  ): void {
    const entry = this.entry(tenantId, serverId, scope);
    const requestCursor = page.requestCursor ?? null;

    let staged: Map<string, CachedToolMetadata>;
    if (requestCursor === null) {
      // A cursorless page starts a fresh listing for this runtime. Reusing the
      // same listing id is safe because the runtime has explicitly restarted.
      staged = new Map<string, CachedToolMetadata>();
    } else {
      const existing = entry.staged.get(listingId);
      if (!existing || existing.expectedCursor !== requestCursor) {
        // Never publish a terminal fragment that did not continue a listing
        // started by the same runtime.
        this.logger?.warn({ tenantId, serverId }, "Ignoring proxy tool page without a matching staged listing; restart tools/list without a cursor");
        return;
      }
      staged = existing.tools;
    }

    for (const tool of page.tools) {
      if (tool && typeof tool.name === "string") {
        staged.set(tool.name, { readOnly: readOnlyOf(tool), resourceUri: appResourceUriOf(tool) });
      }
    }

    const nextCursor = page.nextCursor ?? null;
    if (nextCursor === null) {
      // Listing complete — this is now the authoritative map for the server.
      entry.published = staged;
      entry.staged.delete(listingId);
      return;
    }
    // Bound abandoned listings by count, without expiring slow upstream pages.
    // Refresh insertion order so capacity eviction selects the least active listing.
    entry.staged.delete(listingId);
    if (entry.staged.size >= 100) {
      entry.staged.delete(entry.staged.keys().next().value!);
      this.logger?.warn({ tenantId, serverId }, "Evicted least recently active proxy tool listing at capacity");
    }
    entry.staged.set(listingId, { tools: staged, expectedCursor: nextCursor });
  }

  /**
   * Returns whether the tool is known to be read-only for the given tenant and
   * server, or undefined when the last complete listing did not name it.
   */
  isReadOnly(tenantId: string, serverId: string, toolName: string, scope = ""): boolean | undefined {
    return this.published(tenantId, serverId, scope)?.get(toolName)?.readOnly;
  }

  appResourceUri(tenantId: string, serverId: string, toolName: string, scope = ""): string | null {
    return this.published(tenantId, serverId, scope)?.get(toolName)?.resourceUri ?? null;
  }

  async refreshMissing(tenantId: string, serverId: string, toolName: string, load: () => Promise<void>, scope = ""): Promise<void> {
    if (this.isReadOnly(tenantId, serverId, toolName, scope) !== undefined) return;
    const serverKey = JSON.stringify([tenantId, serverId, scope]);
    const toolKey = JSON.stringify([tenantId, serverId, scope, toolName]);
    if ((this.missingUntil.get(toolKey) ?? 0) > Date.now()) return;
    let running = this.refreshes.get(serverKey);
    if (!running) {
      running = load().finally(() => this.refreshes.delete(serverKey));
      this.refreshes.set(serverKey, running);
    }
    try {
      await running;
    } finally {
      if (this.isReadOnly(tenantId, serverId, toolName, scope) === undefined) {
        this.missingUntil.set(toolKey, Date.now() + 30_000);
        if (this.missingUntil.size > 1_000) this.missingUntil.delete(this.missingUntil.keys().next().value!);
      }
    }
  }

  /**
   * Clears the cache for a specific tenant and server, a whole tenant, or completely if no arguments are specified.
   */
  clear(tenantId?: string, serverId?: string): void {
    for (const [key, entry] of this.scopeOrder) {
      const [entryServer] = JSON.parse(entry.serverKey) as [string, string];
      if ((tenantId === undefined || tenantId === entry.tenantId) &&
          (serverId === undefined || serverId === entryServer)) this.scopeOrder.delete(key);
    }
    for (const key of this.missingUntil.keys()) {
      const [entryTenant, entryServer] = JSON.parse(key) as [string, string, string, string];
      if ((tenantId === undefined || tenantId === entryTenant) && (serverId === undefined || serverId === entryServer)) {
        this.missingUntil.delete(key);
      }
    }
    if (tenantId !== undefined && serverId !== undefined) {
      const tenantCache = this.cache.get(tenantId);
      for (const key of tenantCache?.keys() ?? []) {
        const [entryServer] = JSON.parse(key) as [string, string];
        if (entryServer === serverId) tenantCache?.delete(key);
      }
      if (tenantCache?.size === 0) this.cache.delete(tenantId);
    } else if (tenantId !== undefined) {
      this.cache.delete(tenantId);
    } else {
      this.cache.clear();
    }
  }
}
