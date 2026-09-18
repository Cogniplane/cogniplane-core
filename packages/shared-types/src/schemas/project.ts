import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";
import { SessionSchema } from "./session.js";
import { ArtifactSchema } from "./artifact.js";

export const ProjectNameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const ProjectApprovalModeSchema = z.enum(["organization_default", "manual", "automatic"]);
export type ProjectApprovalMode = z.infer<typeof ProjectApprovalModeSchema>;
export const ProjectAgentFileModeSchema = z.enum(["read-only", "create-only", "read-write"]);
export type ProjectAgentFileMode = z.infer<typeof ProjectAgentFileModeSchema>;
export const ProjectApprovalModeUpdateSchema = z.object({
  approvalMode: ProjectApprovalModeSchema
}).strict();
export const ProjectAgentFileModeUpdateSchema = z.object({
  agentFileMode: ProjectAgentFileModeSchema
}).strict();
export const ProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  instructions: z.string(),
  instructionsRevision: z.number().int().nonnegative(),
  referenceSessionId: z.string(),
  approvalMode: ProjectApprovalModeSchema,
  agentFileMode: ProjectAgentFileModeSchema,
  archivedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export type Project = z.infer<typeof ProjectSchema>;
export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectSchema) });
export const ProjectDetailSchema = z.object({
  project: ProjectSchema,
  sessions: z.array(SessionSchema),
  files: z.array(ArtifactSchema),
  canManage: z.boolean(),
  canEdit: z.boolean().optional(),
  trash: z.object({
    sessions: z.array(SessionSchema),
    retentionDays: z.number().int().nonnegative().optional()
  }).optional(),
  activity: z.array(z.object({
    eventId: z.string(),
    type: z.string(),
    userId: z.string().nullable(),
    createdAt: IsoDateSchema
  })).optional()
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const ProjectRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const ProjectSharingUpdateSchema = z.object({
  visibility: z.enum(["private", "organization"]),
  organizationRole: z.enum(["viewer", "editor"]),
  confirmAudience: z.boolean().default(false)
}).strict();
export const ProjectMemberUpdateSchema = z.object({
  role: ProjectRoleSchema.nullable(),
  confirmRetainedRole: z.enum(["viewer", "editor"]).optional()
}).strict();
export const ProjectMembersResponseSchema = z.object({
  visibility: z.enum(["private", "organization"]),
  organizationRole: z.enum(["viewer", "editor"]),
  members: z.array(z.object({
    userId: z.string(), role: ProjectRoleSchema,
    displayName: z.string().nullable(), email: z.string().nullable()
  }))
});
export const ProjectMemberUpdateResponseSchema = z.object({
  role: ProjectRoleSchema.nullable(), effectiveRole: ProjectRoleSchema.nullable()
});
export const ProjectOwnerRecoverySchema = z.object({ userId: z.string().min(1).max(255) }).strict();
export const OwnerlessProjectsResponseSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), name: z.string() }))
});
