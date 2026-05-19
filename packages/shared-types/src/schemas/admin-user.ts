import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const AdminUserSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(["owner", "admin", "member"]),
  isBetaTester: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
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
