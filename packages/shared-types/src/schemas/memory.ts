import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

// Long-term memories the agent recalls across sessions. A user lists, edits and
// deletes their own memories under /me/memories. The agent only proposes new
// ones, and the user approves the exact text before it is saved.

/** Largest memory text, shared by the agent tool, the store and the settings view. */
export const MEMORY_CONTENT_MAX_LENGTH = 8_000;
/** Memory names are stable lowercase identifiers. */
export const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,127}$/;

// Where the saved text came from. Every value is written by the server:
//   unverified      saved before approvals were recorded; nothing proves the user saw it
//   agent_approved  the agent proposed it and the user approved the exact text
//   user_authored   the user wrote or edited it in settings
export const MEMORY_PROVENANCES = ["unverified", "agent_approved", "user_authored"] as const;
export const MemoryProvenanceSchema = z.enum(MEMORY_PROVENANCES);
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemoryNameSchema = z.string().regex(MEMORY_NAME_PATTERN);
// Routes address a memory by its id, not its name: a name can be 128 characters, which is
// longer than a URL path segment may be, and an id never changes.
export const MemoryIdSchema = z.string().min(1).max(64);

// The account that a response belongs to. A write sends it back, so a tab left
// open under one organization or user cannot change another's memory.
export const MemoryScopeSchema = z.object({
  tenantId: z.string().min(1), userId: z.string().min(1)
}).strict();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySchema = z.object({
  id: MemoryIdSchema,
  name: MemoryNameSchema,
  content: z.string(),
  // Written by the model when it saved the memory. It is never proof of approval.
  metadata: z.record(z.string(), z.unknown()),
  // +1 on every write. An edit sends it back so it cannot overwrite a newer text.
  version: z.number().int().positive(),
  provenance: MemoryProvenanceSchema,
  approvedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export type Memory = z.infer<typeof MemorySchema>;

export const MemoriesResponseSchema = z.object({
  scope: MemoryScopeSchema,
  memories: z.array(MemorySchema),
  // All of the user's memories. The list holds the most recently updated ones.
  total: z.number().int().nonnegative()
});
export type MemoriesResponse = z.infer<typeof MemoriesResponseSchema>;

export const MemoryResponseSchema = z.object({ scope: MemoryScopeSchema, memory: MemorySchema });
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

export const MemoryUpdateRequestSchema = z.object({
  scope: MemoryScopeSchema,
  content: z.string().refine((value) => value.trim().length > 0, "Memory text must not be empty.")
    .refine((value) => value.length <= MEMORY_CONTENT_MAX_LENGTH,
      `Memory text must be at most ${MEMORY_CONTENT_MAX_LENGTH} characters.`),
  version: z.number().int().positive()
}).strict();
export type MemoryUpdateRequest = z.infer<typeof MemoryUpdateRequestSchema>;

export const MemoryDeleteRequestSchema = z.object({ scope: MemoryScopeSchema }).strict();
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteRequestSchema>;
