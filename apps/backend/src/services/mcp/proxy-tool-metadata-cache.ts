export type ProxyToolMetadata = {
  name: string;
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
  tools: Map<string, boolean>;
  /** The cursor the next page of this listing must carry. */
  expectedCursor: string;
};

type ServerEntry = {
  /** Last complete listing. Only this is ever read by `isReadOnly`. */
  published: Map<string, boolean>;
  /** In-flight listings, isolated by the runtime token that initiated them. */
  staged: Map<string, StagedListing>;
};

function readOnlyOf(tool: ProxyToolMetadata): boolean {
  return tool.annotations?.readOnlyHint === true;
}

/**
 * Per-tenant, per-server map of proxy tool name → upstream `readOnlyHint`.
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
  // Keyed by tenantId -> serverId
  private readonly cache = new Map<string, Map<string, ServerEntry>>();

  private entry(tenantId: string, serverId: string): ServerEntry {
    let tenantMap = this.cache.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map<string, ServerEntry>();
      this.cache.set(tenantId, tenantMap);
    }
    let serverEntry = tenantMap.get(serverId);
    if (!serverEntry) {
      serverEntry = { published: new Map<string, boolean>(), staged: new Map() };
      tenantMap.set(serverId, serverEntry);
    }
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
    page: ProxyToolListPage
  ): void {
    const entry = this.entry(tenantId, serverId);
    const requestCursor = page.requestCursor ?? null;

    let staged: Map<string, boolean>;
    if (requestCursor === null) {
      // A cursorless page starts a fresh listing for this runtime. Reusing the
      // same listing id is safe because the runtime has explicitly restarted.
      staged = new Map<string, boolean>();
    } else {
      const existing = entry.staged.get(listingId);
      if (!existing || existing.expectedCursor !== requestCursor) {
        // Never publish a terminal fragment that did not continue a listing
        // started by the same runtime.
        return;
      }
      staged = existing.tools;
    }

    for (const tool of page.tools) {
      if (tool && typeof tool.name === "string") {
        staged.set(tool.name, readOnlyOf(tool));
      }
    }

    const nextCursor = page.nextCursor ?? null;
    if (nextCursor === null) {
      // Listing complete — this is now the authoritative map for the server.
      entry.published = staged;
      entry.staged.delete(listingId);
      return;
    }
    entry.staged.set(listingId, { tools: staged, expectedCursor: nextCursor });
  }

  /**
   * Returns whether the tool is known to be read-only for the given tenant and
   * server, or undefined when the last complete listing did not name it.
   */
  isReadOnly(tenantId: string, serverId: string, toolName: string): boolean | undefined {
    return this.cache.get(tenantId)?.get(serverId)?.published.get(toolName);
  }

  /**
   * Clears the cache for a specific tenant and server, a whole tenant, or completely if no arguments are specified.
   */
  clear(tenantId?: string, serverId?: string): void {
    if (tenantId !== undefined && serverId !== undefined) {
      this.cache.get(tenantId)?.delete(serverId);
    } else if (tenantId !== undefined) {
      this.cache.delete(tenantId);
    } else {
      this.cache.clear();
    }
  }
}
