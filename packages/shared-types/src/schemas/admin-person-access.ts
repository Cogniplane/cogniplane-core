import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";

// Read-only explanation of which organization skills and MCP connections a new
// standalone chat for one member includes. The backend makes every decision;
// the frontend only maps these codes to copy.

export const PERSON_ACCESS_GATES = [
  "visible_to_member",
  "allowed_for_organization",
  "in_member_defaults",
  "has_instructions",
  "personal_sign_in"
] as const;
export const PersonAccessGateSchema = z.enum(PERSON_ACCESS_GATES);
export type PersonAccessGate = z.infer<typeof PersonAccessGateSchema>;

export const PersonAccessGateResultSchema = z.enum(["pass", "fail", "unknown", "not_checked"]);
export type PersonAccessGateResult = z.infer<typeof PersonAccessGateResultSchema>;

export const PERSON_ACCESS_REASONS = [
  "turned_off",
  "test_users_only",
  "not_allowed_for_organization",
  "not_in_member_defaults",
  "no_instructions",
  "member_not_connected",
  "member_must_reconnect",
  "personal_sign_in_not_configured",
  "sign_in_not_accepted",
  "legacy_settings_pending"
] as const;
export const PersonAccessReasonSchema = z.enum(PERSON_ACCESS_REASONS);
export type PersonAccessReason = z.infer<typeof PersonAccessReasonSchema>;

export const PERSON_ACCESS_NOT_COVERED = [
  "projects",
  "existing_chats",
  "personal_skills",
  "project_skills",
  "built_in_integrations",
  "tool_permissions",
  "policy_rules",
  "models_and_budgets",
  "live_connection_health"
] as const;
export const PersonAccessNotCoveredSchema = z.enum(PERSON_ACCESS_NOT_COVERED);
export type PersonAccessNotCovered = z.infer<typeof PersonAccessNotCoveredSchema>;

export const PersonAccessItemStatusSchema = z.enum(["included", "excluded", "unknown"]);
export type PersonAccessItemStatus = z.infer<typeof PersonAccessItemStatusSchema>;

// A reason explains a failed or undecided check only.
export const PersonAccessGateCheckSchema = z.object({
  gate: PersonAccessGateSchema,
  result: PersonAccessGateResultSchema,
  reason: PersonAccessReasonSchema.optional()
}).strict().refine(
  (check) => check.reason === undefined || check.result === "fail" || check.result === "unknown",
  { message: "Only a failed or unknown check can have a reason.", path: ["reason"] }
);
export type PersonAccessGateCheck = z.infer<typeof PersonAccessGateCheckSchema>;

export const PersonAccessItemSchema = z.object({
  kind: z.enum(["skill", "connection"]),
  id: z.string().min(1),
  name: z.string(),
  // Source of the row the runtime would use; null when no row is eligible.
  runtimeSource: z.enum(["organization", "system"]).nullable(),
  // Source of the row that the admin detail page shows.
  adminPageSource: z.enum(["organization", "system"]),
  // Connections only: who signs in to the service. Null for skills.
  signIn: z.enum(["organization", "personal"]).nullable(),
  status: PersonAccessItemStatusSchema,
  // Ordered checks. After the first fail or unknown result, later checks are not_checked.
  gates: z.array(PersonAccessGateCheckSchema)
}).strict().superRefine((item, context) => {
  const gates = item.gates.map((check) => check.gate);
  if (new Set(gates).size !== gates.length) {
    context.addIssue({ code: "custom", message: "Each check can appear only once.", path: ["gates"] });
  }
  const results = new Set(item.gates.map((check) => check.result));
  const consistent =
    item.status === "included" ? !results.has("fail") && !results.has("unknown")
    : item.status === "excluded" ? results.has("fail")
    : results.has("unknown") && !results.has("fail");
  if (!consistent) {
    context.addIssue({ code: "custom", message: "The status does not agree with the checks.", path: ["status"] });
  }
});
export type PersonAccessItem = z.infer<typeof PersonAccessItemSchema>;

export const AdminPersonAccessResponseSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  scope: z.literal("new_standalone_chat"),
  checkedAt: IsoDateSchema,
  member: z.object({
    isTestUser: z.boolean(),
    defaults: z.enum(["inherited", "custom", "empty"])
  }).strict(),
  notCovered: z.array(PersonAccessNotCoveredSchema),
  items: z.array(PersonAccessItemSchema)
}).strict();
export type AdminPersonAccessResponse = z.infer<typeof AdminPersonAccessResponseSchema>;
