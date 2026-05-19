import { test, expect } from "vitest";

import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

import { createNotionTools, markdownToNotionBlocks, NOTION_TOOL_CATALOG } from "./notion-tools.js";

// Valid Notion IDs used as test fixtures (32 hex chars or dashed UUID).
// Notion IDs are now validated before URL interpolation, so test inputs must
// match the canonical shape.
const PAGE_ID = "11111111111111111111111111111111";
const PAGE_ID_2 = "22222222-2222-2222-2222-222222222222";
const DB_ID = "33333333333333333333333333333333";
const BLOCK_ID = "44444444444444444444444444444444";
const PARENT_PAGE_ID = "55555555555555555555555555555555";
const PARENT_DB_ID = "66666666666666666666666666666666";

const TOOL_CONTEXT: ToolExecutionContext = {
  toolContextId: "ctx-1",
  tenantId: "tenant-1",
  sessionId: "session-1",
  userId: "user-1",
  runtimeId: "runtime-1",
  runtimePolicyId: "profile-1",
  messageId: null,
  credentialEnvelope: {},
  metadata: {},
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  createdAt: new Date().toISOString()
};

class FakeNotionConnections {
  hasCreds: boolean;

  constructor(hasCreds = true) {
    this.hasCreds = hasCreds;
  }

  async getRuntimeCredentials(_tenantId: string, _userId: string) {
    if (!this.hasCreds) return null;
    return {
      notionUserId: "notion-user-1",
      workspaceId: "ws-xyz",
      workspaceName: "Test Workspace",
      ownerEmail: "test@example.com",
      ownerName: "Test User",
      token: "secret_notion_token"
    };
  }
}

function findTool(name: string) {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections() });
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("NOTION_TOOL_CATALOG declares 6 tools with consistent readOnly flags", () => {
  expect(NOTION_TOOL_CATALOG.length).toBe(6);
  const readOnly = new Map(NOTION_TOOL_CATALOG.map((t) => [t.name, t.readOnly]));
  expect(readOnly.get("notion_search")).toBe(true);
  expect(readOnly.get("notion_fetch_page")).toBe(true);
  expect(readOnly.get("notion_query_database")).toBe(true);
  expect(readOnly.get("notion_create_page")).toBe(false);
  expect(readOnly.get("notion_update_page")).toBe(false);
  expect(readOnly.get("notion_append_blocks")).toBe(false);
});

test("notion_search returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const search = tools.find((t) => t.name === "notion_search")!;

  const result = await search.handler({
    context: TOOL_CONTEXT,
    arguments: { toolContextId: "ctx-1", query: "hello" }
  });
  expect(String(result.error)).toMatch(/No Notion connection found/);
});

test("notion_search posts to /search and summarises results", async () => {
  const search = findTool("notion_search");
  let capturedUrl = "";
  let capturedHeaders: Headers | null = null;
  let capturedBody: string | null = null;

  const restore = stubFetch(async (input, init) => {
    capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    capturedHeaders = new Headers(init?.headers as HeadersInit | undefined);
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(
      JSON.stringify({
        results: [
          {
            object: "page",
            id: "page-1",
            url: "https://notion.so/page-1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Hello world" }] }
            }
          },
          { object: "database", id: "db-1", url: "https://notion.so/db-1", title: [{ plain_text: "Tasks" }] }
        ],
        has_more: false,
        next_cursor: null
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await search.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", query: "hello", filter: "page", pageSize: 10 }
    });
    expect(capturedUrl).toBe("https://api.notion.com/v1/search");
    expect(capturedHeaders!.get("Authorization")).toBe("Bearer secret_notion_token");
    expect(capturedHeaders!.get("Notion-Version")).toBe("2025-09-03");
    const body = JSON.parse(capturedBody!);
    expect(body.query).toBe("hello");
    expect(body.filter).toEqual({ property: "object", value: "page" });
    expect(body.page_size).toBe(10);

    const results = result.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Hello world");
    expect(results[0].type).toBe("page");
    expect(results[1].title).toBe("Tasks");
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBe(null);
  } finally {
    restore();
  }
});

test("notion_search surfaces API errors with status and detail", async () => {
  const search = findTool("notion_search");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    })
  );

  try {
    const result = await search.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", query: "x" }
    });
    expect(result.error).toBe("Notion API error 429");
    expect(result.detail).toEqual({ message: "rate_limited" });
  } finally {
    restore();
  }
});

test("notion_fetch_page reads page + recurses children", async () => {
  const fetchPage = findTool("notion_fetch_page");
  const calls: string[] = [];
  const restore = stubFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === `https://api.notion.com/v1/pages/${PAGE_ID}`) {
      return new Response(
        JSON.stringify({
          id: PAGE_ID,
          url: "https://notion.so/page-1",
          properties: { Name: { type: "title", title: [{ plain_text: "Hello" }] } }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.startsWith(`https://api.notion.com/v1/blocks/${PAGE_ID}/children`)) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "block-a",
              type: "heading_1",
              has_children: false,
              heading_1: { rich_text: [{ plain_text: "Hello" }] }
            },
            {
              id: "block-b",
              type: "paragraph",
              has_children: true,
              paragraph: { rich_text: [{ plain_text: "outer" }] }
            }
          ],
          has_more: false,
          next_cursor: null
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.startsWith("https://api.notion.com/v1/blocks/block-b/children")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "block-c",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "inner" }] }
            }
          ],
          has_more: false,
          next_cursor: null
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  });

  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: PAGE_ID }
    });
    expect(result.id).toBe(PAGE_ID);
    expect(result.title).toBe("Hello");
    expect(String(result.content)).toMatch(/# Hello/);
    expect(String(result.content)).toMatch(/outer/);
    expect(String(result.content)).toMatch(/inner/);
    expect(result.truncated).toBe(false);
    // Page fetch + 2 block fetches (root + block-b)
    expect(calls.length).toBe(3);
  } finally {
    restore();
  }
});

test("notion_query_database forwards filter and sort", async () => {
  const query = findTool("notion_query_database");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    expect(url).toBe(`https://api.notion.com/v1/databases/${DB_ID}/query`);
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(
      JSON.stringify({ results: [{ id: "row-1" }], has_more: false, next_cursor: null }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await query.handler({
      context: TOOL_CONTEXT,
      arguments: {
        toolContextId: "ctx-1",
        databaseId: DB_ID,
        filter: { property: "Status", status: { equals: "Done" } },
        sorts: [{ property: "Name", direction: "ascending" }],
        pageSize: 5
      }
    });

    const body = JSON.parse(capturedBody!);
    expect(body.filter).toEqual({ property: "Status", status: { equals: "Done" } });
    expect(body.sorts.length).toBe(1);
    expect(body.page_size).toBe(5);
    expect(result.results).toEqual([{ id: "row-1" }]);
  } finally {
    restore();
  }
});

test("notion_create_page rejects missing parent", async () => {
  const create = findTool("notion_create_page");
  const result = await create.handler({
    context: TOOL_CONTEXT,
    arguments: { toolContextId: "ctx-1", title: "Whatever" }
  });
  expect(String(result.error)).toMatch(/parentPageId or parentDatabaseId is required/);
});

test("notion_create_page rejects both parents", async () => {
  const create = findTool("notion_create_page");
  const result = await create.handler({
    context: TOOL_CONTEXT,
    arguments: {
      toolContextId: "ctx-1",
      parentPageId: PARENT_PAGE_ID,
      parentDatabaseId: PARENT_DB_ID,
      title: "X"
    }
  });
  expect(String(result.error)).toMatch(/mutually exclusive/);
});

test("notion_create_page under a page parent sends title property and converts content", async () => {
  const create = findTool("notion_create_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(
      JSON.stringify({ id: "new-page", url: "https://notion.so/new-page" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await create.handler({
      context: TOOL_CONTEXT,
      arguments: {
        toolContextId: "ctx-1",
        parentPageId: PARENT_PAGE_ID,
        title: "My new page",
        content: "# Heading\n\nA paragraph."
      }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.parent).toEqual({ type: "page_id", page_id: PARENT_PAGE_ID });
    expect(body.properties.title).toEqual([{ type: "text", text: { content: "My new page" } }]);
    expect(Array.isArray(body.children)).toBeTruthy();
    expect(body.children[0].type).toBe("heading_1");
    expect(body.children[1].type).toBe("paragraph");
    expect(result.id).toBe("new-page");
    expect(result.parentType).toBe("page");
  } finally {
    restore();
  }
});

test("notion_update_page rejects empty body", async () => {
  const update = findTool("notion_update_page");
  const result = await update.handler({
    context: TOOL_CONTEXT,
    arguments: { toolContextId: "ctx-1", pageId: PAGE_ID }
  });
  expect(String(result.error)).toMatch(/at least one of/);
});

test("notion_update_page sends archived flag", async () => {
  const update = findTool("notion_update_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(
      JSON.stringify({ id: PAGE_ID, url: "https://notion.so/page-1", archived: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await update.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: PAGE_ID, archived: true }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.archived).toBe(true);
    expect(result.archived).toBe(true);
  } finally {
    restore();
  }
});

test("notion_append_blocks converts markdown and posts children", async () => {
  const append = findTool("notion_append_blocks");
  let capturedBody: string | null = null;
  let capturedUrl = "";
  const restore = stubFetch(async (input, init) => {
    capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const result = await append.handler({
      context: TOOL_CONTEXT,
      arguments: {
        toolContextId: "ctx-1",
        blockId: BLOCK_ID,
        content: "- one\n- two\n\n```js\nlet x = 1;\n```"
      }
    });
    expect(capturedUrl).toBe(`https://api.notion.com/v1/blocks/${BLOCK_ID}/children`);
    const body = JSON.parse(capturedBody!);
    expect(body.children.length).toBe(3);
    expect(body.children[0].type).toBe("bulleted_list_item");
    expect(body.children[2].type).toBe("code");
    expect(body.children[2].code.language).toBe("javascript");
    expect(result.appendedCount).toBe(3);
  } finally {
    restore();
  }
});

test("notion_append_blocks errors when content empty after parse", async () => {
  const append = findTool("notion_append_blocks");
  const result = await append.handler({
    context: TOOL_CONTEXT,
    arguments: { toolContextId: "ctx-1", blockId: BLOCK_ID, content: "   \n  \n" }
  });
  expect(String(result.error)).toMatch(/empty/);
});

test("notion_fetch_page returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const t = tools.find((x) => x.name === "notion_fetch_page")!;
  const result = await t.handler({
    context: TOOL_CONTEXT,
    arguments: { pageId: PAGE_ID }
  });
  expect(String(result.error)).toMatch(/No Notion connection/);
});

test("notion_query_database returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const t = tools.find((x) => x.name === "notion_query_database")!;
  const result = await t.handler({
    context: TOOL_CONTEXT,
    arguments: { databaseId: DB_ID }
  });
  expect(String(result.error)).toMatch(/No Notion connection/);
});

test("notion_create_page returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const t = tools.find((x) => x.name === "notion_create_page")!;
  const result = await t.handler({
    context: TOOL_CONTEXT,
    arguments: { parentPageId: PARENT_PAGE_ID }
  });
  expect(String(result.error)).toMatch(/No Notion connection/);
});

test("notion_update_page returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const t = tools.find((x) => x.name === "notion_update_page")!;
  const result = await t.handler({
    context: TOOL_CONTEXT,
    arguments: { pageId: PAGE_ID, archived: true }
  });
  expect(String(result.error)).toMatch(/No Notion connection/);
});

test("notion_append_blocks returns error when no connection exists", async () => {
  const tools = createNotionTools({ notionConnections: new FakeNotionConnections(false) });
  const t = tools.find((x) => x.name === "notion_append_blocks")!;
  const result = await t.handler({
    context: TOOL_CONTEXT,
    arguments: { blockId: BLOCK_ID, content: "hi" }
  });
  expect(String(result.error)).toMatch(/No Notion connection/);
});

test("notion_search omits filter when 'all' is passed and clamps invalid pageSize", async () => {
  const search = findTool("notion_search");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  try {
    await search.handler({
      context: TOOL_CONTEXT,
      arguments: { filter: "all", pageSize: "not-a-number" }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.filter).toBe(undefined);
    expect(body.page_size).toBe(25); // fallback
  } finally {
    restore();
  }
});

test("notion_search uses 'database' filter and falls back hasMore/nextCursor", async () => {
  const search = findTool("notion_search");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(
      JSON.stringify({ results: "not-an-array", next_cursor: 12 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  try {
    const result = await search.handler({
      context: TOOL_CONTEXT,
      arguments: { filter: "database" }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.filter).toEqual({ property: "object", value: "database" });
    // results not array -> empty
    expect(result.results).toEqual([]);
    // has_more missing -> false; next_cursor not a string -> null
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBe(null);
  } finally {
    restore();
  }
});

test("notion_search summarizes a non-page non-database hit as type+id+null title", async () => {
  const search = findTool("notion_search");
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({
        results: [
          { object: "block", id: "b1", url: "https://x" },
          // Garbage hit (not an object) — falls through to defaults
          null
        ],
        has_more: true,
        next_cursor: "c1"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  try {
    const result = (await search.handler({
      context: TOOL_CONTEXT,
      arguments: {}
    })) as { results: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string };
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("c1");
    expect(result.results[0].type).toBe("block");
    expect(result.results[0].title).toBe(null);
    // null hit becomes default empty record
    expect(result.results[1].id).toBe("");
    expect(result.results[1].type).toBe("unknown");
  } finally {
    restore();
  }
});

test("notion_fetch_page surfaces page-fetch API errors", async () => {
  const fetchPage = findTool("notion_fetch_page");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "not found" }), { status: 404 })
  );
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { pageId: PAGE_ID }
    });
    expect(String(result.error)).toMatch(/Notion API error 404/);
  } finally {
    restore();
  }
});

test("notion_fetch_page: maxDepth caps recursion and marks truncated=true", async () => {
  const fetchPage = findTool("notion_fetch_page");
  const restore = stubFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === `https://api.notion.com/v1/pages/${PAGE_ID_2}`) {
      return new Response(
        JSON.stringify({ id: PAGE_ID_2, url: "https://x", properties: {} }),
        { status: 200 }
      );
    }
    if (url.startsWith(`https://api.notion.com/v1/blocks/${PAGE_ID_2}/children`)) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "child-1",
              type: "paragraph",
              has_children: true,
              paragraph: { rich_text: [{ plain_text: "level-1" }] }
            }
          ],
          has_more: false
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      // depth=1 means visit() halts before fetching child block children
      arguments: { pageId: PAGE_ID_2, maxDepth: 1 }
    });
    expect(result.truncated).toBe(true);
    expect(String(result.content)).toMatch(/level-1/);
  } finally {
    restore();
  }
});

test("notion_fetch_page: a child block fetch failure marks truncated=true", async () => {
  const fetchPage = findTool("notion_fetch_page");
  const restore = stubFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `https://api.notion.com/v1/pages/${PAGE_ID_2}`) {
      return new Response(
        JSON.stringify({ id: PAGE_ID_2, url: null, properties: {} }),
        { status: 200 }
      );
    }
    // Fail the very first /blocks/.../children call
    return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { pageId: PAGE_ID_2 }
    });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("");
  } finally {
    restore();
  }
});

test("notion_fetch_page: rich block types render markdown for headings/lists/quote/code/to_do", async () => {
  const fetchPage = findTool("notion_fetch_page");
  const restore = stubFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `https://api.notion.com/v1/pages/${PAGE_ID_2}`) {
      return new Response(JSON.stringify({ id: PAGE_ID_2, url: null, properties: {} }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        results: [
          { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "H2" }] } },
          { id: "b2", type: "heading_3", has_children: false, heading_3: { rich_text: [{ plain_text: "H3" }] } },
          { id: "b3", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [{ plain_text: "bullet" }] } },
          { id: "b4", type: "numbered_list_item", has_children: false, numbered_list_item: { rich_text: [{ plain_text: "num" }] } },
          { id: "b5", type: "quote", has_children: false, quote: { rich_text: [{ plain_text: "q" }] } },
          { id: "b6", type: "code", has_children: false, code: { language: "rust", rich_text: [{ plain_text: "fn x(){}" }] } },
          { id: "b7", type: "to_do", has_children: false, to_do: { checked: true, rich_text: [{ plain_text: "done" }] } },
          { id: "b8", type: "to_do", has_children: false, to_do: { checked: false, rich_text: [{ plain_text: "todo" }] } },
          { id: "b9", type: "divider", has_children: false, divider: {} },
          // Block whose `inner` is missing for the type — should produce empty text
          { id: "b10", type: "missing-inner" },
          // Non-object entry should be skipped
          null
        ],
        has_more: false
      }),
      { status: 200 }
    );
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { pageId: PAGE_ID_2 }
    });
    const content = String(result.content);
    expect(content).toMatch(/^## H2/m);
    expect(content).toMatch(/### H3/);
    expect(content).toMatch(/- bullet/);
    expect(content).toMatch(/1\. num/);
    expect(content).toMatch(/> q/);
    expect(content).toMatch(/```rust\nfn x\(\)\{\}\n```/);
    expect(content).toMatch(/\[x\] done/);
    expect(content).toMatch(/\[ \] todo/);
  } finally {
    restore();
  }
});

test("notion_query_database returns error on API failure", async () => {
  const query = findTool("notion_query_database");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "bad" }), { status: 400 })
  );
  try {
    const result = await query.handler({
      context: TOOL_CONTEXT,
      arguments: { databaseId: DB_ID }
    });
    expect(String(result.error)).toMatch(/Notion API error 400/);
  } finally {
    restore();
  }
});

test("notion_query_database with no filter/sorts and missing has_more", async () => {
  const query = findTool("notion_query_database");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ results: "not-array" }), { status: 200 })
  );
  try {
    const result = await query.handler({
      context: TOOL_CONTEXT,
      arguments: { databaseId: DB_ID }
    });
    // results not an array -> empty
    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBe(null);
  } finally {
    restore();
  }
});

test("notion_create_page under a database parent: title goes into Name property when not pre-supplied", async () => {
  const create = findTool("notion_create_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify({ id: "new", url: "https://x" }), { status: 200 });
  });
  try {
    const result = await create.handler({
      context: TOOL_CONTEXT,
      arguments: {
        parentDatabaseId: PARENT_DB_ID,
        title: "Auto Name"
      }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.parent).toEqual({ type: "database_id", database_id: PARENT_DB_ID });
    // Auto-injected Name property
    expect(body.properties.Name).toEqual({ title: [{ type: "text", text: { content: "Auto Name" } }] });
    expect(result.parentType).toBe("database");
  } finally {
    restore();
  }
});

test("notion_create_page under a database parent: pre-supplied properties are NOT overwritten", async () => {
  const create = findTool("notion_create_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify({ id: "new" }), { status: 200 });
  });
  try {
    await create.handler({
      context: TOOL_CONTEXT,
      arguments: {
        parentDatabaseId: PARENT_DB_ID,
        title: "ignored",
        properties: { Name: { title: [{ text: { content: "from-caller" } }] } }
      }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.properties.Name).toEqual({ title: [{ text: { content: "from-caller" } }] });
  } finally {
    restore();
  }
});

test("notion_create_page surfaces API errors", async () => {
  const create = findTool("notion_create_page");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "no" }), { status: 401 })
  );
  try {
    const result = await create.handler({
      context: TOOL_CONTEXT,
      arguments: { parentPageId: PARENT_PAGE_ID }
    });
    expect(String(result.error)).toMatch(/Notion API error 401/);
  } finally {
    restore();
  }
});

test("notion_create_page omits children when content has no parsed blocks", async () => {
  const create = findTool("notion_create_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify({ id: "new" }), { status: 200 });
  });
  try {
    await create.handler({
      context: TOOL_CONTEXT,
      arguments: {
        parentPageId: PARENT_PAGE_ID,
        title: "T",
        content: "   \n   "
      }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.children).toBe(undefined);
  } finally {
    restore();
  }
});

test("notion_update_page surfaces API errors", async () => {
  const update = findTool("notion_update_page");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "no" }), { status: 403 })
  );
  try {
    const result = await update.handler({
      context: TOOL_CONTEXT,
      arguments: { pageId: PAGE_ID, archived: true }
    });
    expect(String(result.error)).toMatch(/Notion API error 403/);
  } finally {
    restore();
  }
});

test("notion_update_page: properties without archived works", async () => {
  const update = findTool("notion_update_page");
  let capturedBody: string | null = null;
  const restore = stubFetch(async (_, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify({ id: PAGE_ID, archived: false }), { status: 200 });
  });
  try {
    const result = await update.handler({
      context: TOOL_CONTEXT,
      arguments: { pageId: PAGE_ID, properties: { Name: { title: [] } } }
    });
    const body = JSON.parse(capturedBody!);
    expect(body.properties).toEqual({ Name: { title: [] } });
    expect(body.archived).toBe(undefined);
    expect(result.archived).toBe(false);
  } finally {
    restore();
  }
});

test("notion_append_blocks surfaces API errors", async () => {
  const append = findTool("notion_append_blocks");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ message: "no" }), { status: 422 })
  );
  try {
    const result = await append.handler({
      context: TOOL_CONTEXT,
      arguments: { blockId: BLOCK_ID, content: "# hi" }
    });
    expect(String(result.error)).toMatch(/Notion API error 422/);
  } finally {
    restore();
  }
});

// ── Notion ID validation: reject prompt-injectable URL path segments ───────

test("notion_fetch_page rejects path-traversal in pageId", async () => {
  const fetchPage = findTool("notion_fetch_page");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: "../users/me" }
    });
    expect(String(result.error)).toMatch(/Invalid pageId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_fetch_page rejects pageId with query-string injection", async () => {
  const fetchPage = findTool("notion_fetch_page");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: "abc?secret=x&" }
    });
    expect(String(result.error)).toMatch(/Invalid pageId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_query_database rejects malformed databaseId", async () => {
  const query = findTool("notion_query_database");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await query.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", databaseId: "../databases/secret" }
    });
    expect(String(result.error)).toMatch(/Invalid databaseId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_update_page rejects malformed pageId", async () => {
  const update = findTool("notion_update_page");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await update.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: "not-a-uuid", archived: true }
    });
    expect(String(result.error)).toMatch(/Invalid pageId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_append_blocks rejects malformed blockId", async () => {
  const append = findTool("notion_append_blocks");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await append.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", blockId: "abc/../boom", content: "# hi" }
    });
    expect(String(result.error)).toMatch(/Invalid blockId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_create_page rejects malformed parentPageId", async () => {
  const create = findTool("notion_create_page");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await create.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", parentPageId: "../users/me" }
    });
    expect(String(result.error)).toMatch(/Invalid parentPageId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_create_page rejects malformed parentDatabaseId", async () => {
  const create = findTool("notion_create_page");
  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  try {
    const result = await create.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", parentDatabaseId: "garbage-id" }
    });
    expect(String(result.error)).toMatch(/Invalid parentDatabaseId/);
    expect(fetchCalled).toBe(false);
  } finally {
    restore();
  }
});

test("notion_fetch_page accepts dashed-UUID pageId form", async () => {
  const fetchPage = findTool("notion_fetch_page");
  let capturedUrl = "";
  const restore = stubFetch(async (input) => {
    capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (capturedUrl === `https://api.notion.com/v1/pages/${PAGE_ID_2}`) {
      return new Response(
        JSON.stringify({ id: PAGE_ID_2, url: null, properties: {} }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
  });
  try {
    const result = await fetchPage.handler({
      context: TOOL_CONTEXT,
      arguments: { toolContextId: "ctx-1", pageId: PAGE_ID_2 }
    });
    expect(result.id).toBe(PAGE_ID_2);
  } finally {
    restore();
  }
});

test("markdownToNotionBlocks covers headings, lists, fences, and quotes", () => {
  const blocks = markdownToNotionBlocks(
    [
      "# Title",
      "## Sub",
      "### Sub-sub",
      "Paragraph text.",
      "- bullet",
      "1. numbered",
      "> quoted",
      "```python",
      "x = 1",
      "```"
    ].join("\n")
  );
  const types = blocks.map((b) => b.type);
  expect(types).toEqual([
        "heading_1",
        "heading_2",
        "heading_3",
        "paragraph",
        "bulleted_list_item",
        "numbered_list_item",
        "quote",
        "code"
      ]);
  const codeBlock = blocks[7] as { code: { language: string } };
  expect(codeBlock.code.language).toBe("python");
});
