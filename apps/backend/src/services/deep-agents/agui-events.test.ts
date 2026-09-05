import { expect, test } from "vitest";
import { CogniplaneCustomEventSchema } from "@cogniplane/shared-types";

import { approvalRequiredEvent, runtimeNoticeEvent } from "./agui-events.js";

test("approval and expiry emitters satisfy the browser payload contract", () => {
  const events = [
    approvalRequiredEvent({
      approvalId: "approval-1", itemId: "tool-1", kind: "mcp_tool",
      title: "Write file", summary: "Save the requested report",
      availableDecisions: ["approve", "reject"], command: null, cwd: null
    }),
    runtimeNoticeEvent({
      noticeId: "approval-expired:approval-1", level: "warning",
      title: "Approval expired", message: "The request expired.",
      createdAt: new Date().toISOString()
    })
  ];
  for (const event of events) {
    expect(CogniplaneCustomEventSchema.safeParse(event).success).toBe(true);
  }
});
