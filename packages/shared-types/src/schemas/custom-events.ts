import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { ApprovalSchema, McpAppCallSchema } from "./message.js";

// AG-UI's CUSTOM envelope is open-ended. These are the payloads Cogniplane owns.
// The current backend does not send `tool_ui_resources` or
// `mcp_server_status`, so they are not listed. Readers ignore them when an
// older backend or a replay sends them.
//
// The backend consumers `services/agui-turn-accumulator.ts` (where to save
// each event) and `services/turn-transcript.ts` switch on `name` with a
// `never` check, so a new event fails the backend build until each one
// decides what to do with it. The browser hook `use-agui-custom-events.ts`
// has a `default` branch and does not fail the build.
export const CogniplaneCustomEventSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("turn_started"),
    value: z.object({ messageId: z.string(), sequence: z.number().int().nonnegative() })
  }),
  z.object({
    name: z.literal("approval_required"),
    value: z.object({
      approvalId: z.string().min(1),
      itemId: z.string(),
      kind: ApprovalSchema.shape.kind,
      title: z.string(),
      summary: z.string(),
      availableDecisions: z.array(z.enum(["approve", "reject"])).optional(),
      command: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      toolCallId: ApprovalSchema.shape.toolCallId,
      allowForTurn: ApprovalSchema.shape.allowForTurn
    })
  }),
  z.object({
    name: z.literal("runtime_notice"),
    value: z.object({
      noticeId: z.string().min(1),
      level: z.enum(["info", "warning", "error"]),
      title: z.string(),
      message: z.string(),
      createdAt: IsoDateSchema
    })
  }),
  z.object({
    name: z.literal("tool_meta"),
    value: z.object({
      toolCallId: z.string().min(1),
      kind: z.enum(["command", "mcp"]).optional(),
      server: z.string().nullable().optional(),
      command: z.string().nullable().optional()
    })
  }),
  z.object({
    name: z.literal("tool_status"),
    value: z.object({
      toolCallId: z.string().min(1),
      toolName: z.string().optional(),
      status: z.enum(["failed", "declined"]),
      durationMs: z.number().nullable().optional()
    })
  }),
  z.object({
    name: z.literal("tool_mcp_app"),
    value: z.object({
      toolCallId: z.string().min(1),
      app: McpAppCallSchema
    })
  }),
  z.object({
    name: z.literal("user_message_persisted"),
    value: z.object({ messageId: z.string().min(1), text: z.string() })
  }),
  z.object({
    name: z.literal("user_message_replaced"),
    value: z.object({
      messageId: z.string().min(1),
      text: z.string(),
      scanRunId: z.string().nullable().optional()
    })
  }),
  // Sent once by `GET /sessions/:id/connect`, inside the run that carries the
  // saved history. `activeTurn` tells the browser what follows that run:
  // - "none": no turn runs, and the stream ends.
  // - "attached": the running turn follows as a second run, replay then live.
  // - "unavailable": a turn runs, but this connection cannot replay it. The
  //   stream ends, and the browser must confirm the end of the turn itself.
  // `hasMoreHistory` is true when older messages were left out of the history.
  z.object({
    name: z.literal("session_connection"),
    value: z.object({
      activeTurn: z.enum(["none", "attached", "unavailable"]),
      hasMoreHistory: z.boolean()
    })
  })
]);

export type CogniplaneCustomEvent = z.infer<typeof CogniplaneCustomEventSchema>;
export type CustomEventValue<Name extends CogniplaneCustomEvent["name"]> =
  Extract<CogniplaneCustomEvent, { name: Name }>["value"];

// Approval expiry has no event of its own: the backend sends a
// `runtime_notice` whose noticeId is this prefix and the approval id
// (`runtime/approval-coordinator.ts`). The browser removes the approval card.
export const APPROVAL_EXPIRED_NOTICE_PREFIX = "approval-expired:";

// Read only. The current backend does not send this prefix. The browser still
// reads it, because saved runtime notices of older turns can have it. Do not
// emit it.
export const LEGACY_POLICY_APPROVAL_EXPIRED_NOTICE_PREFIX = "policy-approval-expired:";

const EXPIRED_APPROVAL_NOTICE_PREFIXES = [
  APPROVAL_EXPIRED_NOTICE_PREFIX,
  LEGACY_POLICY_APPROVAL_EXPIRED_NOTICE_PREFIX
] as const;

export function approvalExpiredNoticeId(approvalId: string): string {
  return `${APPROVAL_EXPIRED_NOTICE_PREFIX}${approvalId}`;
}

/** The approval id of an expiry notice, or null for any other notice. */
export function expiredApprovalIdFromNotice(noticeId: string): string | null {
  for (const prefix of EXPIRED_APPROVAL_NOTICE_PREFIXES) {
    if (noticeId.startsWith(prefix) && noticeId.length > prefix.length) {
      return noticeId.slice(prefix.length);
    }
  }
  return null;
}
