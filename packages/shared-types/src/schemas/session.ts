import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { MessagesListResponseSchema } from "./message.js";

export const SESSION_TRASH_RETENTION_DAYS = 30;

export const SessionSchema = z.object({
  sessionId: z.string(),
  projectId: z.string().nullable().optional(),
  userId: z.string(),
  sessionName: z.string(),
  status: z.enum(["active", "archived", "deleted"]),
  // Coarse session bucket (e.g. "normal", "scheduled"); default is "normal".
  // Optional because production rows always carry a value (NOT NULL DEFAULT 'normal')
  // but in-memory test fakes may omit it.
  purpose: z.string().optional(),
  archivedAt: IsoDateSchema.optional(),
  deletedAt: IsoDateSchema.optional(),
  canEdit: z.boolean().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  hasPendingApprovals: z.boolean().optional(),
  isRunning: z.boolean().optional(),
  activeTurnStartedAt: IsoDateSchema.optional(),
  latestTurnId: z.string().optional(),
  latestTurnSequence: z.number().int().nonnegative().optional(),
  hasTurnFailed: z.boolean().optional()
}).passthrough();

export type Session = z.infer<typeof SessionSchema>;

export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  trashRetentionDays: z.number().int().nonnegative().optional()
}).passthrough();

export type SessionsListResponse = z.infer<typeof SessionsListResponseSchema>;

export const SessionEnvelopeSchema = z.object({
  session: SessionSchema
}).passthrough();

export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>;

// The same payload MessagesListResponseSchema describes, plus the session
// envelope. Extended rather than redeclared so `messages`/`hasMore` cannot drift
// between the schema the backend serializes with and the one the frontend parses
// with — that drift is what let `hasMore` reach the client untyped.
export const SessionMessagesResponseSchema = MessagesListResponseSchema.extend({
  session: SessionSchema
});

export type SessionMessagesResponse = z.infer<typeof SessionMessagesResponseSchema>;

export const SessionCapabilitySelectionSchema = z.object({
  skillIds: z.array(z.string().min(1).max(200)).max(500),
  connectorIds: z.array(z.string().min(1).max(200)).max(500)
}).strict();
export type SessionCapabilitySelection = z.infer<typeof SessionCapabilitySelectionSchema>;

export const SessionCapabilitiesUpdateSchema = z.object({
  selection: SessionCapabilitySelectionSchema.nullable(),
  version: z.number().int().nonnegative()
}).strict();
export type SessionCapabilitiesUpdate = z.infer<typeof SessionCapabilitiesUpdateSchema>;

const SessionCapabilityOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string()
});
export const SessionCapabilitiesSchema = SessionCapabilitiesUpdateSchema.extend({
  skills: z.array(SessionCapabilityOptionSchema),
  connectors: z.array(SessionCapabilityOptionSchema),
  canEdit: z.boolean()
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
