import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { ApprovalSchema, UiResourceSchema } from "./message.js";

// AG-UI's CUSTOM envelope is open-ended. These are the payloads Cogniplane owns.
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
    name: z.literal("tool_ui_resources"),
    value: z.object({
      toolCallId: z.string().min(1),
      uiResources: z.array(UiResourceSchema)
    })
  }),
  z.object({
    name: z.literal("user_message_replaced"),
    value: z.object({
      messageId: z.string().min(1),
      text: z.string(),
      scanRunId: z.string().nullable().optional()
    })
  })
]);

export type CogniplaneCustomEvent = z.infer<typeof CogniplaneCustomEventSchema>;
export type CustomEventValue<Name extends CogniplaneCustomEvent["name"]> =
  Extract<CogniplaneCustomEvent, { name: Name }>["value"];
