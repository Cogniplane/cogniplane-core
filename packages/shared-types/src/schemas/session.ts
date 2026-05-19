import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { MessageSchema } from "./message.js";

export const SessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  sessionName: z.string(),
  status: z.enum(["active", "deleted"]),
  // "skill_improvement" identifies improver sessions; default bucket is "normal".
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

export const SessionMessagesResponseSchema = z.object({
  session: SessionSchema,
  messages: z.array(MessageSchema)
}).passthrough();

export type SessionMessagesResponse = z.infer<typeof SessionMessagesResponseSchema>;

export const SessionImprovementContextSchema = z.object({
  skillId: z.string(),
  skillName: z.string().nullable(),
  corpusArtifactId: z.string().nullable()
}).passthrough();

export type SessionImprovementContext = z.infer<typeof SessionImprovementContextSchema>;
