import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";

export const ADMIN_HISTORY_CATEGORIES = ["settings", "policies", "people", "models", "connections", "skills", "budgets", "runtime"] as const;
export const AdminHistoryCategorySchema = z.enum(ADMIN_HISTORY_CATEGORIES);
export type AdminHistoryCategory = z.infer<typeof AdminHistoryCategorySchema>;

// IDs stay strings: the audit table uses PostgreSQL bigint.
export const AdminHistoryIdSchema = z.string().regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, "Invalid event ID.");
export const AdminHistoryListQuerySchema = z.object({
  category: AdminHistoryCategorySchema.optional(),
  type: z.string().min(1).max(100).optional(),
  section: z.enum(["agent", "policy"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(2048).optional()
}).strict();
export type AdminHistoryListQuery = z.infer<typeof AdminHistoryListQuerySchema>;

export const AdminHistoryEventSchema = z.object({
  eventId: AdminHistoryIdSchema,
  type: z.string(),
  category: AdminHistoryCategorySchema,
  title: z.string(),
  createdAt: IsoDateSchema,
  actor: z.object({ userId: z.string().nullable(), name: z.string() }).strict(),
  details: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  target: z.object({ label: z.string(), href: z.string().startsWith("/admin/") }).strict().nullable(),
  settingsVersion: z.number().int().nonnegative().nullable()
}).strict();
export type AdminHistoryEvent = z.infer<typeof AdminHistoryEventSchema>;

export const AdminHistoryListResponseSchema = z.object({
  items: z.array(AdminHistoryEventSchema),
  nextCursor: z.string().nullable()
}).strict();
export type AdminHistoryListResponse = z.infer<typeof AdminHistoryListResponseSchema>;

const SnapshotReferenceSchema = z.object({
  eventId: AdminHistoryIdSchema,
  version: z.number().int().nonnegative().nullable(),
  createdAt: IsoDateSchema,
  actorName: z.string()
}).strict();
export const AdminSettingsComparisonSchema = z.object({
  before: SnapshotReferenceSchema,
  after: SnapshotReferenceSchema,
  changes: z.array(z.object({
    field: z.string(), label: z.string(), before: z.string(), after: z.string(),
    status: z.enum(["changed", "unavailable"])
  }).strict()),
  unchangedCount: z.number().int().nonnegative()
}).strict();
export type AdminSettingsComparison = z.infer<typeof AdminSettingsComparisonSchema>;

export const AdminHistoryDetailResponseSchema = z.object({
  event: AdminHistoryEventSchema,
  comparison: AdminSettingsComparisonSchema.nullable()
}).strict();
export type AdminHistoryDetailResponse = z.infer<typeof AdminHistoryDetailResponseSchema>;
