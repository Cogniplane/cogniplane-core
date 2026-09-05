import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { MessagesListResponseSchema } from "./message.js";

export const SessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  sessionName: z.string(),
  status: z.enum(["active", "deleted"]),
  // Coarse session bucket (e.g. "normal", "scheduled"); default is "normal".
  // Optional because production rows always carry a value (NOT NULL DEFAULT 'normal')
  // but in-memory test fakes may omit it.
  purpose: z.string().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  hasPendingApprovals: z.boolean().optional(),
  isRunning: z.boolean().optional()
}).passthrough();

export type Session = z.infer<typeof SessionSchema>;

export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionSchema)
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
