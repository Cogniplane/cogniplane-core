import {
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_SEARCH_LIMIT,
  type MemoryRecord,
  type MemoryStore
} from "../memory-store.js";
import { ToolCallError } from "../../lib/tool-call-error.js";
import { allRequiredObjectSchema, arraySchema, type ManagedToolDefinition } from "./types.js";

type MemoryToolDeps = {
  memories: Pick<MemoryStore, "search" | "save" | "remove">;
};

// ── Catalog entries (static metadata consumed by ./catalog) ──────────────────

export const MEMORY_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "memory_search",
    description:
      "Search the user's long-term memories (persisted across sessions). Omit the query to list the most recently updated memories.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_SEARCH_LIMIT }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "memory_save",
    description:
      "Save (or overwrite) a long-term memory for the current user. Use a short kebab-case name and concise content — durable facts, preferences, and decisions worth recalling in future sessions.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        name: {
          type: "string",
          description: "Stable memory identifier (lowercase, kebab-case). Saving an existing name overwrites it."
        },
        content: { type: "string", maxLength: MAX_MEMORY_CONTENT_LENGTH },
        metadata: { type: "object", additionalProperties: true }
      },
      required: ["toolContextId", "name", "content"],
      additionalProperties: false
    }
  },
  {
    name: "memory_delete",
    description: "Delete a long-term memory by name when it is wrong or obsolete.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        name: { type: "string" }
      },
      required: ["toolContextId", "name"],
      additionalProperties: false
    }
  }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const memoryOutputSchema = allRequiredObjectSchema({
  name: { type: "string" },
  content: { type: "string" },
  metadata: { type: "object", additionalProperties: true },
  updatedAt: { type: "string" }
});

function toMemoryOutput(memory: MemoryRecord): Record<string, unknown> {
  return {
    name: memory.slug,
    content: memory.content,
    metadata: memory.metadata,
    updatedAt: memory.updatedAt
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export function createMemoryTools(deps: MemoryToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...MEMORY_TOOL_CATALOG[0], // memory_search
      outputSchema: allRequiredObjectSchema({
        memories: arraySchema(memoryOutputSchema)
      }),
      handler: async ({ context, arguments: args }) => {
        const query = typeof args.query === "string" ? args.query : undefined;
        // Default + clamping live in the store — single owner of the limit policy.
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const memories = await deps.memories.search(context.tenantId, context.userId, {
          query,
          limit
        });
        return { memories: memories.map(toMemoryOutput) };
      }
    },

    {
      ...MEMORY_TOOL_CATALOG[1], // memory_save
      outputSchema: allRequiredObjectSchema({
        saved: memoryOutputSchema
      }),
      handler: async ({ context, arguments: args }) => {
        const name = String(args.name ?? "").trim();
        const content = String(args.content ?? "");
        if (!name) throw new ToolCallError("name is required.");
        const metadata =
          args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
            ? (args.metadata as Record<string, unknown>)
            : undefined;
        const saved = await deps.memories.save(context.tenantId, context.userId, {
          slug: name,
          content,
          metadata
        });
        return { saved: toMemoryOutput(saved) };
      }
    },

    {
      ...MEMORY_TOOL_CATALOG[2], // memory_delete
      outputSchema: allRequiredObjectSchema({
        deleted: { type: "boolean" },
        name: { type: "string" }
      }),
      handler: async ({ context, arguments: args }) => {
        const name = String(args.name ?? "").trim();
        if (!name) throw new ToolCallError("name is required.");
        const deleted = await deps.memories.remove(context.tenantId, context.userId, name);
        return { deleted, name };
      }
    }
  ];
}
