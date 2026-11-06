import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { LinkEmailStatusSchema, LocalAccountStatusSchema } from "./local-auth.js";

export const AdminUserSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(["owner", "admin", "member"]),
  isBetaTester: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  /** Local accounts only; null or absent for WorkOS members. */
  accountStatus: LocalAccountStatusSchema.nullable().optional(),
  /** Local accounts only: a second factor (authenticator app or passkey) is set up. */
  mfaEnabled: z.boolean().optional(),
  /** Local accounts only. */
  passkeyCount: z.number().int().optional(),
  /** Local accounts with email on: the latest link email, or null when none. */
  linkEmail: LinkEmailStatusSchema.nullable().optional()
}).passthrough();
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUsersListResponseSchema = z.object({
  users: z.array(AdminUserSchema)
}).passthrough();
export type AdminUsersListResponse = z.infer<typeof AdminUsersListResponseSchema>;

export const AdminUserEnvelopeSchema = z.object({
  user: AdminUserSchema
}).passthrough();
export type AdminUserEnvelope = z.infer<typeof AdminUserEnvelopeSchema>;
