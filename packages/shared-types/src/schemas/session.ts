import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { MessagesListResponseSchema } from "./message.js";

export const SESSION_TRASH_RETENTION_DAYS = 30;

// The history format of a session's transcript, from the server.
//   current      the chat can reopen and continue the session.
//   legacy       saved in the previous history format. The rows stay stored,
//                and audit and history reads still work, but the chat does
//                not reopen or continue the session.
//   unsupported  a later format that this version does not know.
export const TranscriptFormatSchema = z.enum(["current", "legacy", "unsupported"]);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

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
  hasTurnFailed: z.boolean().optional(),
  // Production rows always carry a value; in-memory test fakes may omit it.
  // An absent value never means "current": the chat does not continue it.
  transcriptFormat: TranscriptFormatSchema.optional()
}).passthrough();

export type Session = z.infer<typeof SessionSchema>;

export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable().optional(),
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
  description: z.string(),
  source: z.enum(["organization", "personal", "project"]).optional(),
  connectionStatus: z.enum(["not_connected", "connected", "reconnect_required", "organization", "no_auth", "unavailable"]).optional(),
  accountLabel: z.string().nullable().optional()
});
export const SessionCapabilitiesSchema = SessionCapabilitiesUpdateSchema.extend({
  skills: z.array(SessionCapabilityOptionSchema),
  connectors: z.array(SessionCapabilityOptionSchema),
  canEdit: z.boolean(),
  defaultsSource: z.enum(["organization", "project", "personal"]).default("organization")
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

export const ProjectCapabilitiesSchema = SessionCapabilitiesSchema.omit({ defaultsSource: true });
export type ProjectCapabilities = z.infer<typeof ProjectCapabilitiesSchema>;
export const ProjectCapabilitiesUpdateSchema = SessionCapabilitiesUpdateSchema;
export type ProjectCapabilitiesUpdate = z.infer<typeof ProjectCapabilitiesUpdateSchema>;

const PersonalCapabilityScopeSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1)
}).strict();
export const PersonalCapabilitiesSchema = ProjectCapabilitiesSchema.extend({ scope: PersonalCapabilityScopeSchema });
export type PersonalCapabilities = z.infer<typeof PersonalCapabilitiesSchema>;
export const PersonalCapabilitiesUpdateSchema = SessionCapabilitiesUpdateSchema.extend({ scope: PersonalCapabilityScopeSchema });
export type PersonalCapabilitiesUpdate = z.infer<typeof PersonalCapabilitiesUpdateSchema>;
