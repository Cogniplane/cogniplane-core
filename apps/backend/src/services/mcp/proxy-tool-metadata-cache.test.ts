import { describe, expect, it, vi } from "vitest";

import { MAX_PROXY_TOOL_METADATA_SCOPES, ProxyToolMetadataCache, type ProxyToolMetadata } from "./proxy-tool-metadata-cache.js";

/** A complete single-page listing (no request cursor, no nextCursor). */
function recordCompleteListing(
  cache: ProxyToolMetadataCache,
  tenantId: string,
  serverId: string,
  tools: readonly ProxyToolMetadata[]
): void {
  cache.recordToolsPage(tenantId, serverId, "listing-default", { tools });
}

describe("ProxyToolMetadataCache", () => {
  it("evicts old credential scopes while keeping active members isolated", async () => {
    const cache = new ProxyToolMetadataCache();
    const tools = [{ name: "read", annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://active" } } }];
    cache.recordToolsPage("tenant-b", "server", "b", { tools }, "member-b:v1");
    cache.recordToolsPage("tenant-a", "server", "zero", { tools }, "member-a:v0");
    for (let version = 1; version < MAX_PROXY_TOOL_METADATA_SCOPES - 1; version += 1) {
      cache.recordToolsPage("tenant-a", "server", String(version), { tools }, `member-a:v${version}`);
    }
    expect(cache.isReadOnly("tenant-b", "server", "read", "member-b:v1")).toBe(true);
    expect(cache.appResourceUri("tenant-a", "server", "read", "member-a:v0")).toBe("ui://active");
    cache.recordToolsPage("tenant-a", "server", "new", { tools }, "member-a:new");
    expect(cache.isReadOnly("tenant-a", "server", "read", "member-a:v1")).toBeUndefined();
    expect(cache.appResourceUri("tenant-a", "server", "read", "member-a:v1")).toBeNull();
    expect(cache.isReadOnly("tenant-b", "server", "read", "member-b:v1")).toBe(true);
    expect(cache.isReadOnly("tenant-a", "server", "read", "member-a:v0")).toBe(true);
    await cache.refreshMissing("tenant-a", "server", "read", async () => {
      cache.recordToolsPage("tenant-a", "server", "refreshed", { tools }, "member-a:v1");
    }, "member-a:v1");
    expect(cache.isReadOnly("tenant-a", "server", "read", "member-a:v1")).toBe(true);
  });
  it("separates tool metadata by member, server binding, and credential version", () => {
    const cache = new ProxyToolMetadataCache();
    cache.recordToolsPage("tenant", "server", "one", { tools: [{ name: "tool", annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://one" } } }] }, "member-one:binding-a:v1");
    expect(cache.isReadOnly("tenant", "server", "tool", "member-one:binding-a:v1")).toBe(true);
    expect(cache.appResourceUri("tenant", "server", "tool", "member-two:binding-a:v1")).toBeNull();
    expect(cache.isReadOnly("tenant", "server", "tool", "member-one:binding-a:v2")).toBeUndefined();
    expect(cache.isReadOnly("tenant", "server", "tool", "member-one:binding-b:v1")).toBeUndefined();
    cache.clear("tenant", "server");
    expect(cache.isReadOnly("tenant", "server", "tool", "member-one:binding-a:v1")).toBeUndefined();
  });
  it("shares one refresh and caches an absent tool briefly", async () => {
    const cache = new ProxyToolMetadataCache();
    let finish!: () => void;
    const loader = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = cache.refreshMissing("t", "s", "missing", loader);
    const second = cache.refreshMissing("t", "s", "missing", loader);
    expect(loader).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    await cache.refreshMissing("t", "s", "missing", loader);
    expect(loader).toHaveBeenCalledOnce();
    cache.clear("t", "s");
    const afterClear = cache.refreshMissing("t", "s", "missing", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    finish();
    await afterClear;
  });
  it("publishes app links only from the complete listing for the same tenant and server", () => {
    const cache = new ProxyToolMetadataCache();
    cache.recordToolsPage("tenant-a", "server", "listing", {
      tools: [{ name: "show_quote_picker", _meta: { ui: { resourceUri: "ui://quote-picker/app.html" } } }],
      nextCursor: "next"
    });
    expect(cache.appResourceUri("tenant-a", "server", "show_quote_picker")).toBeNull();
    cache.recordToolsPage("tenant-a", "server", "listing", { requestCursor: "next", tools: [] });
    expect(cache.appResourceUri("tenant-a", "server", "show_quote_picker")).toBe("ui://quote-picker/app.html");
    expect(cache.appResourceUri("tenant-b", "server", "show_quote_picker")).toBeNull();
    expect(cache.appResourceUri("tenant-a", "other", "show_quote_picker")).toBeNull();
    recordCompleteListing(cache, "tenant-a", "server", [{ name: "show_quote_picker" }]);
    expect(cache.appResourceUri("tenant-a", "server", "show_quote_picker")).toBeNull();
  });

  it("completes slow pagination even when another tenant lists tools during the wait", () => {
    vi.useFakeTimers();
    try {
      const cache = new ProxyToolMetadataCache();
      cache.recordToolsPage("t", "s", "old", { tools: [{ name: "first", annotations: { readOnlyHint: true } }], nextCursor: "next" });
      vi.advanceTimersByTime(6 * 60_000);
      cache.recordToolsPage("other", "s", "fresh", { tools: [] });
      cache.recordToolsPage("t", "s", "old", { tools: [{ name: "fragment" }], requestCursor: "next" });
      expect(cache.isReadOnly("t", "s", "first")).toBe(true);
      expect(cache.isReadOnly("t", "s", "fragment")).toBe(false);
      cache.recordToolsPage("t", "s", "fresh", { tools: [{ name: "fresh" }] });
      expect(cache.isReadOnly("t", "s", "fresh")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds abandoned listings while retaining active ones and reporting eviction", () => {
    const warn = vi.fn();
    const cache = new ProxyToolMetadataCache({ warn });
    for (let i = 0; i < 100; i += 1) {
      cache.recordToolsPage("t", "s", String(i), { tools: [{ name: String(i) }], nextCursor: "next" });
    }
    cache.recordToolsPage("t", "s", "0", { tools: [], requestCursor: "next", nextCursor: "last" });
    cache.recordToolsPage("t", "s", "new", { tools: [], nextCursor: "next" });
    expect(warn).toHaveBeenCalledTimes(1);
    cache.recordToolsPage("t", "s", "1", { tools: [{ name: "orphan" }], requestCursor: "next" });
    expect(cache.isReadOnly("t", "s", "orphan")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    cache.recordToolsPage("t", "s", "0", { tools: [], requestCursor: "last" });
    expect(cache.isReadOnly("t", "s", "0")).toBe(false);
  });
  it("returns undefined for uncached tools, servers, or tenants", () => {
    const cache = new ProxyToolMetadataCache();
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_a")).toBeUndefined();
  });

  it("records tools and derives readOnly status correctly from readOnlyHint", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "read_query", annotations: { readOnlyHint: true } },
      { name: "write_query", annotations: { readOnlyHint: false } },
      { name: "noop_query", annotations: {} },
      { name: "bare_query" }
    ]);

    expect(cache.isReadOnly("tenant-1", "srv-1", "read_query")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "write_query")).toBe(false);
    expect(cache.isReadOnly("tenant-1", "srv-1", "noop_query")).toBe(false);
    expect(cache.isReadOnly("tenant-1", "srv-1", "bare_query")).toBe(false);
    expect(cache.isReadOnly("tenant-1", "srv-1", "unknown")).toBeUndefined();
  });

  it("isolates tools by serverId", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "my_tool", annotations: { readOnlyHint: true } }
    ]);
    recordCompleteListing(cache, "tenant-1", "srv-2", [
      { name: "my_tool", annotations: { readOnlyHint: false } }
    ]);

    expect(cache.isReadOnly("tenant-1", "srv-1", "my_tool")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-2", "my_tool")).toBe(false);
  });

  it("isolates tools by tenantId (two tenants with identically-named servers do not share cache entries)", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-a", "acme-mcp", [
      { name: "delete_record", annotations: { readOnlyHint: true } }
    ]);
    recordCompleteListing(cache, "tenant-b", "acme-mcp", [
      { name: "delete_record", annotations: { readOnlyHint: false } }
    ]);

    expect(cache.isReadOnly("tenant-a", "acme-mcp", "delete_record")).toBe(true);
    expect(cache.isReadOnly("tenant-b", "acme-mcp", "delete_record")).toBe(false);
    expect(cache.isReadOnly("tenant-c", "acme-mcp", "delete_record")).toBeUndefined();
  });

  it("accumulates tools across sequential cursor pages and publishes them on the final page", () => {
    const cache = new ProxyToolMetadataCache();
    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      nextCursor: "c1",
      tools: [{ name: "tool_page_1", annotations: { readOnlyHint: true } }]
    });
    // Nothing is readable until the listing completes.
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_page_1")).toBeUndefined();

    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      requestCursor: "c1",
      tools: [{ name: "tool_page_2", annotations: { readOnlyHint: false } }]
    });

    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_page_1")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_page_2")).toBe(false);
  });

  it("overwrites an earlier duplicate tool name on a later complete listing", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "tool_dup", annotations: { readOnlyHint: false } }
    ]);
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_dup")).toBe(false);

    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "tool_dup", annotations: { readOnlyHint: true } }
    ]);
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool_dup")).toBe(true);
  });

  it("evicts a tool that a later complete listing no longer advertises", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "retired_read_tool", annotations: { readOnlyHint: true } },
      { name: "kept_tool", annotations: { readOnlyHint: true } }
    ]);
    expect(cache.isReadOnly("tenant-1", "srv-1", "retired_read_tool")).toBe(true);

    // The upstream drops the read-only tool. A stale `true` here would let a
    // same-named mutating tool bypass file_change severity gating.
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "kept_tool", annotations: { readOnlyHint: true } }
    ]);

    expect(cache.isReadOnly("tenant-1", "srv-1", "retired_read_tool")).toBeUndefined();
    expect(cache.isReadOnly("tenant-1", "srv-1", "kept_tool")).toBe(true);
  });

  it("only replaces the server's map once a multi-page listing reaches its final page", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "old_tool", annotations: { readOnlyHint: true } }
    ]);

    // A fresh paginated listing that no longer contains old_tool.
    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      nextCursor: "c1",
      tools: [{ name: "new_tool_a", annotations: { readOnlyHint: true } }]
    });
    // Mid-sequence: the previous complete listing is still authoritative.
    expect(cache.isReadOnly("tenant-1", "srv-1", "old_tool")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "new_tool_a")).toBeUndefined();

    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      requestCursor: "c1",
      tools: [{ name: "new_tool_b", annotations: { readOnlyHint: false } }]
    });

    expect(cache.isReadOnly("tenant-1", "srv-1", "old_tool")).toBeUndefined();
    expect(cache.isReadOnly("tenant-1", "srv-1", "new_tool_a")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "new_tool_b")).toBe(false);
  });

  it("leaves the previous complete listing intact when pagination fails mid-sequence", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "stable_tool", annotations: { readOnlyHint: true } }
    ]);

    // Page 1 of a refresh succeeds; page 2 fails (transport error, JSON-RPC
    // error, malformed body) so the route never records it.
    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      nextCursor: "c1",
      tools: [{ name: "partial_tool", annotations: { readOnlyHint: true } }]
    });

    expect(cache.isReadOnly("tenant-1", "srv-1", "stable_tool")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "partial_tool")).toBeUndefined();
  });

  it("restarts one runtime's staging when it sends a new cursorless page", () => {
    const cache = new ProxyToolMetadataCache();
    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      nextCursor: "c1",
      tools: [{ name: "abandoned_page", annotations: { readOnlyHint: true } }]
    });

    // The same runtime starts from scratch (no request cursor) and completes.
    cache.recordToolsPage("tenant-1", "srv-1", "listing-1", {
      tools: [{ name: "fresh_tool", annotations: { readOnlyHint: false } }]
    });

    expect(cache.isReadOnly("tenant-1", "srv-1", "abandoned_page")).toBeUndefined();
    expect(cache.isReadOnly("tenant-1", "srv-1", "fresh_tool")).toBe(false);
  });

  it("keeps concurrent listings with the same cursor self-consistent", () => {
    const cache = new ProxyToolMetadataCache();

    cache.recordToolsPage("tenant-1", "srv-1", "listing-a", {
      nextCursor: "shared-cursor",
      tools: [{ name: "only_in_a", annotations: { readOnlyHint: true } }]
    });
    cache.recordToolsPage("tenant-1", "srv-1", "listing-b", {
      nextCursor: "shared-cursor",
      tools: [{ name: "only_in_b", annotations: { readOnlyHint: false } }]
    });

    cache.recordToolsPage("tenant-1", "srv-1", "listing-a", {
      requestCursor: "shared-cursor",
      tools: [{ name: "a_final", annotations: { readOnlyHint: true } }]
    });
    expect(cache.isReadOnly("tenant-1", "srv-1", "only_in_a")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "a_final")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "only_in_b")).toBeUndefined();

    cache.recordToolsPage("tenant-1", "srv-1", "listing-b", {
      requestCursor: "shared-cursor",
      tools: [{ name: "b_final", annotations: { readOnlyHint: false } }]
    });
    expect(cache.isReadOnly("tenant-1", "srv-1", "only_in_a")).toBeUndefined();
    expect(cache.isReadOnly("tenant-1", "srv-1", "only_in_b")).toBe(false);
    expect(cache.isReadOnly("tenant-1", "srv-1", "b_final")).toBe(false);
  });

  it("does not publish an unmatched terminal page", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "stable_tool", annotations: { readOnlyHint: true } }
    ]);

    cache.recordToolsPage("tenant-1", "srv-1", "listing-orphan", {
      requestCursor: "cursor-never-issued-to-this-listing",
      tools: [{ name: "partial_tool", annotations: { readOnlyHint: true } }]
    });

    expect(cache.isReadOnly("tenant-1", "srv-1", "stable_tool")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "partial_tool")).toBeUndefined();
  });

  it("handles malformed tool entries without corrupting the cache or throwing", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      null as unknown as { name: string },
      undefined as unknown as { name: string },
      { name: 123 } as unknown as { name: string },
      { name: "" },
      { name: "valid_tool", annotations: { readOnlyHint: true } }
    ]);

    expect(cache.isReadOnly("tenant-1", "srv-1", "valid_tool")).toBe(true);
    expect(cache.isReadOnly("tenant-1", "srv-1", "")).toBe(false);
  });

  it("clears by serverId, by tenant, or entirely", () => {
    const cache = new ProxyToolMetadataCache();
    recordCompleteListing(cache, "tenant-1", "srv-1", [
      { name: "tool1", annotations: { readOnlyHint: true } }
    ]);
    recordCompleteListing(cache, "tenant-1", "srv-2", [
      { name: "tool2", annotations: { readOnlyHint: true } }
    ]);
    recordCompleteListing(cache, "tenant-2", "srv-1", [
      { name: "tool3", annotations: { readOnlyHint: true } }
    ]);

    cache.clear("tenant-1", "srv-1");
    expect(cache.isReadOnly("tenant-1", "srv-1", "tool1")).toBeUndefined();
    expect(cache.isReadOnly("tenant-1", "srv-2", "tool2")).toBe(true);
    expect(cache.isReadOnly("tenant-2", "srv-1", "tool3")).toBe(true);

    cache.clear("tenant-1");
    expect(cache.isReadOnly("tenant-1", "srv-2", "tool2")).toBeUndefined();
    expect(cache.isReadOnly("tenant-2", "srv-1", "tool3")).toBe(true);

    cache.clear();
    expect(cache.isReadOnly("tenant-2", "srv-1", "tool3")).toBeUndefined();
  });
});
