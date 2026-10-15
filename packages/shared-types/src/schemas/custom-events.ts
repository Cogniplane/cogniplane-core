import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { ApprovalSchema, McpAppCallSchema } from "./message.js";

// AG-UI's CUSTOM envelope is open-ended. These are the payloads Cogniplane owns.
// The retired `tool_ui_resources` event is not listed. Consumers ignore it.
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
      cwd: z.string().nullable().optional()
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
    name: z.literal("mcp_server_status"),
    value: z.object({
      serverName: z.string(),
      status: z.enum(["starting", "ready", "failed", "cancelled"]),
      error: z.string().optional()
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
