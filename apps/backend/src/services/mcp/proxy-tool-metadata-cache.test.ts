import { describe, expect, it } from "vitest";

import { ProxyToolMetadataCache, type ProxyToolMetadata } from "./proxy-tool-metadata-cache.js";

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
