import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import type { NotionConnectionService } from "../integrations/notion/notion-connection-service.js";
import { markdownToNotionBlocks } from "./notion-markdown-blocks.js";
import {
  allRequiredObjectSchema,
  arraySchema,
  genericObjectSchema,
  nullableStringSchema,
  safeJsonBody,
  strictObjectSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition,
  type ManagedToolHandler
} from "./types.js";

// Notion's REST API requires a pinned version header. 2025-09-03 introduced
// data sources as a new top-level abstraction, but the page/block/database
// endpoints we use here continue to accept legacy database IDs directly, so
// the upgrade is transparent for our tool surface.
// Reference: https://developers.notion.com/reference/versioning
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2025-09-03";

// Block-tree expansion has to be capped — a Notion page can recurse arbitrarily
// deep through nested toggles and synced blocks. 3 levels covers typical
// reading workloads without amplifying token cost runaway.
const NOTION_FETCH_MAX_DEPTH = 3;
// Per-page-children fetch ceiling. Notion's API paginates at 100; we cap at
// 200 to bound a single tool call.
const NOTION_FETCH_MAX_BLOCKS_PER_LEVEL = 200;
// Cap the number of blocks the agent can append in one call. Notion's API
// limit is 100 children per request; we surface it as an explicit guardrail.
const NOTION_APPEND_MAX_BLOCKS = 100;

// Notion IDs are interpolated into the Notion REST API URL. The values come
// from LLM-supplied tool arguments, which can be influenced by prompt
// injection in any document or prior message — so they must be validated
// before becoming part of the URL or the agent could pivot to other Notion
// API endpoints under the user's OAuth token (e.g. `/users/me`, other
// workspaces). The two canonical forms are 32 hex chars (no dashes) and a
// standard UUID layout (`8-4-4-4-12`).
const NOTION_ID_PATTERN = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateNotionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return NOTION_ID_PATTERN.test(value) ? value : null;
}

function invalidNotionIdError(field: string): { error: string } {
  return {
    error: `Invalid ${field}. Expected a Notion ID: 32 hexadecimal characters, with or without dashes (UUID format).`
  };
}

type NotionToolDeps = {
  notionConnections: NotionConnectionService;
};

/**
 * Wrap a Notion-backed handler so credential lookup + the missing-connection
 * error live in one place. Every Notion tool needs a valid OAuth token; if
 * the user has no connection (or it's expired with no refresh path), every
 * tool must short-circuit with the same message — centralizing here makes
 * "forget to check auth" structurally impossible (this is exactly how the
 * prior S1 path-segment-injection slipped past one handler).
 *
 * The handler receives `token` directly so it can pass it to `callNotion`
 * without re-reading `creds.token` per call site.
 */
function withNotionAuth(
  deps: NotionToolDeps,
  fn: (
    token: string,
    input: { context: ToolExecutionContext; arguments: Record<string, unknown> }
  ) => Promise<Record<string, unknown>>
): ManagedToolHandler {
  return async ({ context, arguments: args }) => {
    const creds = await deps.notionConnections.getRuntimeCredentials(context.tenantId, context.userId);
    if (!creds) {
      return { error: "No Notion connection found. Connect your Notion account in settings." };
    }
    return fn(creds.token, { context, arguments: args });
  };
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export const NOTION_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "notion_search",
    description:
      "Search the connected Notion workspace for pages and databases by title. Returns up to `pageSize` results.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        query: { type: "string", description: "Title fragment to match. Empty string returns recently edited items." },
        filter: {
          type: "string",
          enum: ["page", "database"],
          description: "Restrict to pages or databases."
        },
        pageSize: { type: "number", description: "1–100, default 25." }
      },
      required: ["toolContextId", "query"],
      additionalProperties: false
    }
  },
  {
    name: "notion_fetch_page",
    description:
      "Fetch a Notion page's properties and block content as text. Recursively expands child blocks up to a depth limit.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        pageId: { type: "string", description: "Notion page ID (UUID, dashed or unhashed)." },
        maxDepth: {
          type: "number",
          description: "Override the default child-block recursion depth. Default 3, capped at 3."
        }
      },
      required: ["toolContextId", "pageId"],
      additionalProperties: false
    }
  },
  {
    name: "notion_query_database",
    description:
      "Query rows in a Notion database with optional filter/sort. Filter and sort are pass-through to the Notion API.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        databaseId: { type: "string", description: "Notion database ID." },
        filter: {
          type: "object",
          description: "Notion query filter object (see Notion API docs).",
          additionalProperties: true
        },
        sorts: {
          type: "array",
          description: "Notion sort directives.",
          items: { type: "object", additionalProperties: true }
        },
        pageSize: { type: "number", description: "1–100, default 25." }
      },
      required: ["toolContextId", "databaseId"],
      additionalProperties: false
    }
  },
  {
    name: "notion_create_page",
    description:
      "Create a new Notion page under a parent page or database. Optional content is appended as markdown-converted blocks.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        parentPageId: { type: "string", description: "Parent page ID. Mutually exclusive with parentDatabaseId." },
        parentDatabaseId: { type: "string", description: "Parent database ID. Mutually exclusive with parentPageId." },
        title: { type: "string", description: "Page title (required for page parents; optional for database parents that infer title from properties)." },
        properties: {
          type: "object",
          description: "Notion property object — required when parentDatabaseId is set, ignored when parentPageId is set.",
          additionalProperties: true
        },
        content: { type: "string", description: "Optional markdown content to append as the page's body." }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "notion_update_page",
    description: "Update properties on an existing Notion page.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        pageId: { type: "string" },
        properties: { type: "object", additionalProperties: true },
        archived: { type: "boolean", description: "Set true to archive the page." }
      },
      required: ["toolContextId", "pageId"],
      additionalProperties: false
    }
  },
  {
    name: "notion_append_blocks",
    description:
      "Append markdown content to an existing Notion page or block as Notion blocks. Up to 100 blocks per call.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        blockId: { type: "string", description: "Page ID or block ID under which to append." },
        content: { type: "string", description: "Markdown content to convert and append." }
      },
      required: ["toolContextId", "blockId", "content"],
      additionalProperties: false
    }
  }
];

// Re-export so the existing import path from tests / external callers
// (`./notion-tools.js`) remains valid. The implementation lives in
// notion-markdown-blocks.ts.
export { markdownToNotionBlocks };

// ── Notion blocks → flat text ────────────────────────────────────────────────

function richTextToPlain(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return "";
      const obj = entry as Record<string, unknown>;
      const text = obj.plain_text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function blockToText(block: Record<string, unknown>): string {
  const type = String(block.type ?? "");
  const inner = block[type] as Record<string, unknown> | undefined;
  if (!inner) return "";

  const rt = inner.rich_text;
  const text = richTextToPlain(rt);

  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code": {
      const language = String(inner.language ?? "");
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case "to_do": {
      const checked = inner.checked === true;
      return `- [${checked ? "x" : " "}] ${text}`;
    }
    default:
      return text;
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export function createNotionTools(deps: NotionToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...NOTION_TOOL_CATALOG[0], // notion_search
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          results: arraySchema(
            allRequiredObjectSchema({
              id: { type: "string" },
              type: { type: "string" },
              title: nullableStringSchema,
              url: nullableStringSchema
            })
          ),
          hasMore: { type: "boolean" },
          nextCursor: nullableStringSchema
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const filter =
          args.filter === "page"
            ? { property: "object", value: "page" }
            : args.filter === "database"
              ? { property: "object", value: "database" }
              : undefined;

        const body: Record<string, unknown> = {
          query: String(args.query ?? ""),
          page_size: clampPageSize(args.pageSize, 25)
        };
        if (filter) body.filter = filter;

        const res = await callNotion("/search", "POST", token, body);
        if (!res.ok) return notionError(res.status, await safeJsonBody(res.response));

        const data = res.data;
        const rawResults = Array.isArray(data.results) ? data.results : [];
        return {
          results: rawResults.map(summarizeSearchHit),
          hasMore: data.has_more === true,
          nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null
        };
      })
    },

    {
      ...NOTION_TOOL_CATALOG[1], // notion_fetch_page
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          id: { type: "string" },
          url: nullableStringSchema,
          title: nullableStringSchema,
          properties: genericObjectSchema,
          content: { type: "string" },
          truncated: { type: "boolean" }
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const pageId = validateNotionId(args.pageId);
        if (!pageId) return invalidNotionIdError("pageId");
        const maxDepth = Math.min(
          NOTION_FETCH_MAX_DEPTH,
          typeof args.maxDepth === "number" ? Math.max(1, Math.floor(args.maxDepth)) : NOTION_FETCH_MAX_DEPTH
        );

        const pageRes = await callNotion(`/pages/${encodeURIComponent(pageId)}`, "GET", token);
        if (!pageRes.ok) return notionError(pageRes.status, await safeJsonBody(pageRes.response));

        const pageData = pageRes.data;
        const properties = (pageData.properties as Record<string, unknown> | undefined) ?? {};
        const title = extractTitleFromProperties(properties);

        const fetchResult = await fetchBlockTree(token, pageId, maxDepth);
        return {
          id: String(pageData.id ?? pageId),
          url: typeof pageData.url === "string" ? pageData.url : null,
          title,
          properties,
          content: fetchResult.lines.join("\n"),
          truncated: fetchResult.truncated
        };
      })
    },

    {
      ...NOTION_TOOL_CATALOG[2], // notion_query_database
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          results: arraySchema(genericObjectSchema),
          hasMore: { type: "boolean" },
          nextCursor: nullableStringSchema
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const databaseId = validateNotionId(args.databaseId);
        if (!databaseId) return invalidNotionIdError("databaseId");
        const body: Record<string, unknown> = { page_size: clampPageSize(args.pageSize, 25) };
        if (args.filter && typeof args.filter === "object") body.filter = args.filter;
        if (Array.isArray(args.sorts)) body.sorts = args.sorts;

        const res = await callNotion(`/databases/${encodeURIComponent(databaseId)}/query`, "POST", token, body);
        if (!res.ok) return notionError(res.status, await safeJsonBody(res.response));

        const data = res.data;
        return {
          results: Array.isArray(data.results) ? data.results : [],
          hasMore: data.has_more === true,
          nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null
        };
      })
    },

    {
      ...NOTION_TOOL_CATALOG[3], // notion_create_page
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema({
          id: { type: "string" },
          url: nullableStringSchema,
          parentType: { type: "string" }
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const rawParentPageId = typeof args.parentPageId === "string" ? args.parentPageId : null;
        const rawParentDatabaseId = typeof args.parentDatabaseId === "string" ? args.parentDatabaseId : null;

        if (!rawParentPageId && !rawParentDatabaseId) {
          return { error: "Either parentPageId or parentDatabaseId is required." };
        }
        if (rawParentPageId && rawParentDatabaseId) {
          return { error: "parentPageId and parentDatabaseId are mutually exclusive." };
        }

        const parentPageId = rawParentPageId ? validateNotionId(rawParentPageId) : null;
        if (rawParentPageId && !parentPageId) return invalidNotionIdError("parentPageId");
        const parentDatabaseId = rawParentDatabaseId ? validateNotionId(rawParentDatabaseId) : null;
        if (rawParentDatabaseId && !parentDatabaseId) return invalidNotionIdError("parentDatabaseId");

        const body: Record<string, unknown> = {};
        if (parentPageId) {
          body.parent = { type: "page_id", page_id: parentPageId };
        } else {
          body.parent = { type: "database_id", database_id: parentDatabaseId };
        }

        const props = (args.properties && typeof args.properties === "object")
          ? { ...(args.properties as Record<string, unknown>) }
          : {};
        if (parentPageId) {
          // Page parents require a `title` property at the root. Build it from the title arg.
          const titleText = typeof args.title === "string" ? args.title : "";
          props.title = [{ type: "text", text: { content: titleText } }];
        } else if (parentDatabaseId && typeof args.title === "string" && !("Name" in props) && !("title" in props)) {
          // Convenience: when the caller supplies a title for a database parent
          // but didn't put it into properties, add it under "Name" (Notion's default).
          props.Name = { title: [{ type: "text", text: { content: args.title } }] };
        }
        body.properties = props;

        if (typeof args.content === "string" && args.content.length > 0) {
          const blocks = markdownToNotionBlocks(args.content).slice(0, NOTION_APPEND_MAX_BLOCKS);
          if (blocks.length > 0) body.children = blocks;
        }

        const res = await callNotion("/pages", "POST", token, body);
        if (!res.ok) return notionError(res.status, await safeJsonBody(res.response));

        const data = res.data;
        return {
          id: String(data.id ?? ""),
          url: typeof data.url === "string" ? data.url : null,
          parentType: parentPageId ? "page" : "database"
        };
      })
    },

    {
      ...NOTION_TOOL_CATALOG[4], // notion_update_page
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          id: { type: "string" },
          url: nullableStringSchema,
          archived: { type: "boolean" }
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const pageId = validateNotionId(args.pageId);
        if (!pageId) return invalidNotionIdError("pageId");
        const body: Record<string, unknown> = {};
        if (args.properties && typeof args.properties === "object") {
          body.properties = args.properties;
        }
        if (typeof args.archived === "boolean") {
          body.archived = args.archived;
        }
        if (Object.keys(body).length === 0) {
          return { error: "Provide at least one of `properties` or `archived`." };
        }

        const res = await callNotion(`/pages/${encodeURIComponent(pageId)}`, "PATCH", token, body);
        if (!res.ok) return notionError(res.status, await safeJsonBody(res.response));

        const data = res.data;
        return {
          id: String(data.id ?? pageId),
          url: typeof data.url === "string" ? data.url : null,
          archived: data.archived === true
        };
      })
    },

    {
      ...NOTION_TOOL_CATALOG[5], // notion_append_blocks
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          appendedCount: { type: "number" },
          blockId: { type: "string" }
        })
      ),
      handler: withNotionAuth(deps, async (token, { arguments: args }) => {
        const blockId = validateNotionId(args.blockId);
        if (!blockId) return invalidNotionIdError("blockId");
        const blocks = markdownToNotionBlocks(String(args.content)).slice(0, NOTION_APPEND_MAX_BLOCKS);
        if (blocks.length === 0) {
          return { error: "Content is empty after markdown parsing." };
        }

        const res = await callNotion(`/blocks/${encodeURIComponent(blockId)}/children`, "PATCH", token, {
          children: blocks
        });
        if (!res.ok) return notionError(res.status, await safeJsonBody(res.response));

        return { appendedCount: blocks.length, blockId };
      })
    }
  ];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

type NotionApiResult =
  | { ok: true; status: number; response: Response; data: Record<string, unknown> }
  | { ok: false; status: number; response: Response };

async function callNotion(
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: Record<string, unknown>
): Promise<NotionApiResult> {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    return { ok: false, status: response.status, response };
  }
  const data = await safeJsonBody(response);
  return { ok: true, status: response.status, response, data };
}

function notionError(status: number, detail: Record<string, unknown>): Record<string, unknown> {
  return { error: `Notion API error ${status}`, detail };
}

function clampPageSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function summarizeSearchHit(hit: unknown): Record<string, unknown> {
  if (typeof hit !== "object" || hit === null) {
    return { id: "", type: "unknown", title: null, url: null };
  }
  const obj = hit as Record<string, unknown>;
  const objectType = String(obj.object ?? "unknown");
  const id = String(obj.id ?? "");
  const url = typeof obj.url === "string" ? obj.url : null;

  let title: string | null = null;
  if (objectType === "page") {
    const props = obj.properties as Record<string, unknown> | undefined;
    title = props ? extractTitleFromProperties(props) : null;
  } else if (objectType === "database") {
    title = richTextToPlain(obj.title);
    if (!title) title = null;
  }

  return { id, type: objectType, title, url };
}

function extractTitleFromProperties(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    if (typeof value !== "object" || value === null) continue;
    const prop = value as Record<string, unknown>;
    if (prop.type === "title") {
      const plain = richTextToPlain(prop.title);
      if (plain) return plain;
    }
  }
  return null;
}

async function fetchBlockTree(
  token: string,
  rootBlockId: string,
  maxDepth: number
): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];
  let truncated = false;

  async function visit(blockId: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let cursor: string | undefined;
    let fetched = 0;
    do {
      const url = cursor
        ? `/blocks/${encodeURIComponent(blockId)}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${encodeURIComponent(blockId)}/children?page_size=100`;
      const res = await callNotion(url, "GET", token);
      if (!res.ok) {
        truncated = true;
        return;
      }
      const data = res.data;
      const results = Array.isArray(data.results) ? data.results : [];
      for (const block of results) {
        if (typeof block !== "object" || block === null) continue;
        const blockObj = block as Record<string, unknown>;
        const indent = "  ".repeat(Math.max(0, depth - 1));
        const text = blockToText(blockObj);
        if (text) lines.push(`${indent}${text}`);

        if (blockObj.has_children === true && typeof blockObj.id === "string") {
          await visit(blockObj.id, depth + 1);
        }
        fetched += 1;
        if (fetched >= NOTION_FETCH_MAX_BLOCKS_PER_LEVEL) {
          truncated = true;
          return;
        }
      }
      cursor = data.has_more === true && typeof data.next_cursor === "string" ? data.next_cursor : undefined;
    } while (cursor);
  }

  await visit(rootBlockId, 1);
  return { lines, truncated };
}
