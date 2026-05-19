import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const AdminSessionAlertKindSchema = z.enum([
  "pii-blocked",
  "pii-transformed",
  "pii-detected",
  "approval-rejected",
  "approval-pending",
  "errored"
]);
export type AdminSessionAlertKind = z.infer<typeof AdminSessionAlertKindSchema>;

export const AdminSessionAlertSchema = z.object({
  kind: AdminSessionAlertKindSchema,
  count: z.number()
}).passthrough();
export type AdminSessionAlert = z.infer<typeof AdminSessionAlertSchema>;

const RuntimeProviderNullableSchema = z.enum(["codex", "claude-code"]).nullable();

export const AdminSessionRowSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  createdAt: IsoDateSchema,
  lastActivityAt: IsoDateSchema,
  messageCount: z.number(),
  runtimeProvider: RuntimeProviderNullableSchema,
  modelName: z.string().nullable(),
  status: z.enum(["active", "errored"]),
  alerts: z.array(AdminSessionAlertSchema),
  skillsUsedCount: z.number(),
  mcpServersUsedCount: z.number()
}).passthrough();
export type AdminSessionRow = z.infer<typeof AdminSessionRowSchema>;

export const AdminSessionsListResponseSchema = z.object({
  items: z.array(AdminSessionRowSchema),
  nextCursor: z.string().nullable()
}).passthrough();
export type AdminSessionsListResponse = z.infer<typeof AdminSessionsListResponseSchema>;

export const AdminSessionDetailOverviewSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  tenantId: z.string(),
  sessionName: z.string(),
  status: z.enum(["active", "errored"]),
  runtimeProvider: RuntimeProviderNullableSchema,
  createdAt: IsoDateSchema,
  lastActivityAt: IsoDateSchema,
  messageCount: z.number(),
  totalCostUsd: z.number(),
  totalTokens: z.number()
}).passthrough();
export type AdminSessionDetailOverview = z.infer<typeof AdminSessionDetailOverviewSchema>;

export const AdminSessionDetailMessageSchema = z.object({
  messageId: z.string(),
  role: z.string(),
  status: z.string(),
  contentText: z.string(),
  reasoningContent: z.string(),
  planContent: z.string(),
  modelName: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  detailJson: z.unknown(),
  createdAt: IsoDateSchema
}).passthrough();
export type AdminSessionDetailMessage = z.infer<typeof AdminSessionDetailMessageSchema>;

export const AdminSessionDetailApprovalSchema = z.object({
  approvalId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  requestMethod: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.string(),
  decision: z.string().nullable(),
  requestPayload: z.unknown(),
  createdAt: IsoDateSchema,
  resolvedAt: IsoDateSchema.nullable()
}).passthrough();
export type AdminSessionDetailApproval = z.infer<typeof AdminSessionDetailApprovalSchema>;

export const AdminSessionDetailPiiRunSchema = z.object({
  scanRunId: z.string(),
  subjectType: z.enum(["message", "artifact"]),
  subjectId: z.string(),
  sourceUserId: z.string().nullable(),
  mode: z.string(),
  providerType: z.string().nullable(),
  providerModel: z.string().nullable(),
  status: z.string(),
  findings: z.array(z.unknown()),
  summaryText: z.string().nullable(),
  actionTaken: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable()
}).passthrough();
export type AdminSessionDetailPiiRun = z.infer<typeof AdminSessionDetailPiiRunSchema>;

export const AdminSessionDetailAuditEventSchema = z.object({
  eventType: z.string(),
  userId: z.string(),
  approvalId: z.string().nullable(),
  payload: z.unknown(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: IsoDateSchema
}).passthrough();
export type AdminSessionDetailAuditEvent = z.infer<typeof AdminSessionDetailAuditEventSchema>;

export const AdminSessionDetailToolEventSchema = z.object({
  toolCallId: z.string(),
  messageId: z.string().nullable(),
  approvalId: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  phase: z.string(),
  status: z.string(),
  durationMs: z.number().nullable(),
  payload: z.unknown(),
  createdAt: IsoDateSchema
}).passthrough();
export type AdminSessionDetailToolEvent = z.infer<typeof AdminSessionDetailToolEventSchema>;

export const AdminSessionDetailMessageToolResultSchema = z.object({
  toolResultId: z.string(),
  messageId: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.string(),
  serverName: z.string(),
  toolName: z.string(),
  commandText: z.string(),
  inputText: z.string(),
  cwd: z.string(),
  outputText: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  createdAt: IsoDateSchema
}).passthrough();
export type AdminSessionDetailMessageToolResult = z.infer<typeof AdminSessionDetailMessageToolResultSchema>;

export const AdminSessionDetailArtifactSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  artifactName: z.string(),
  mimeType: z.string(),
  fileSizeBytes: z.number(),
  status: z.string(),
  createdAt: IsoDateSchema
}).passthrough();
export type AdminSessionDetailArtifact = z.infer<typeof AdminSessionDetailArtifactSchema>;

export const AdminSessionDetailResourceUsageSchema = z.object({
  resourceId: z.string(),
  name: z.string(),
  materialized: z.boolean(),
  invokedCount: z.number()
}).passthrough();
export type AdminSessionDetailResourceUsage = z.infer<typeof AdminSessionDetailResourceUsageSchema>;

export const AdminSessionDetailResponseSchema = z.object({
  overview: AdminSessionDetailOverviewSchema,
  messages: z.array(AdminSessionDetailMessageSchema),
  approvals: z.array(AdminSessionDetailApprovalSchema),
  piiRuns: z.array(AdminSessionDetailPiiRunSchema),
  auditEvents: z.array(AdminSessionDetailAuditEventSchema),
  toolEvents: z.array(AdminSessionDetailToolEventSchema),
  messageToolResults: z.array(AdminSessionDetailMessageToolResultSchema),
  artifacts: z.array(AdminSessionDetailArtifactSchema),
  skills: z.array(AdminSessionDetailResourceUsageSchema),
  mcpServers: z.array(AdminSessionDetailResourceUsageSchema)
}).passthrough();
export type AdminSessionDetailResponse = z.infer<typeof AdminSessionDetailResponseSchema>;

// Request-shape (query params); kept here for symmetry with the response.
export type AdminSessionsListParams = {
  userId?: string;
  from?: string;
  to?: string;
  status?: AdminSessionRow["status"];
  runtime?: "codex" | "claude-code";
  alert?: AdminSessionAlertKind[];
  cursor?: string;
  limit?: number;
};
