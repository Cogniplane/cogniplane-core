
import type { RuntimeApprovalDecision, RuntimeApprovalKind } from "../../runtime-contracts.js";
import { uuidv7 } from "../../lib/uuid.js";

type ActiveTurnSnapshot = {
  responseId: string | null;
};

export type PendingApprovalRecord = {
  approvalId: string;
  requestId: string | number;
  method: string;
  itemId: string;
  kind: RuntimeApprovalKind;
};

type ApprovalRequestPayload = {
  approvalId: string;
  pending: PendingApprovalRecord;
  turnId: string;
  itemId: string;
  kind: RuntimeApprovalKind;
  title: string;
  summary: string;
  command: string | null;
  cwd: string | null;
  requestPayload: Record<string, unknown>;
};

type RuntimeApprovalContext = {
  activeTurn: ActiveTurnSnapshot | null;
};

type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type ApprovalResponseProcess = {
  sendResponse: (id: string | number, result: Record<string, unknown>) => void;
  sendError: (id: string | number, code: number, message: string) => void;
};

export function buildApprovalRequest(
  runtime: RuntimeApprovalContext,
  request: JsonRpcRequest
): ApprovalRequestPayload | null {
  const params = request.params ?? {};
  const str = (key: string): string | null =>
    typeof params[key] === "string" && params[key] ? (params[key] as string) : null;

  const result = extractApprovalFields(runtime, request.method, str);
  if (!result) {
    return null;
  }

  return {
    ...result,
    pending: {
      approvalId: result.approvalId,
      requestId: request.id,
      method: request.method,
      itemId: result.itemId,
      kind: result.kind
    },
    requestPayload: params
  };
}

function extractApprovalFields(
  runtime: RuntimeApprovalContext,
  method: string,
  str: (key: string) => string | null
) {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const approvalId = str("approvalId") ?? uuidv7();
      const command = str("command");
      const cwd = str("cwd");
      const itemId = str("itemId") ?? approvalId;
      const turnId = str("turnId") ?? runtime.activeTurn?.responseId ?? approvalId;
      return {
        approvalId,
        turnId,
        itemId,
        kind: "command_execution" as const,
        title: "Approve shell command",
        summary: [command, cwd ? `cwd: ${cwd}` : null].filter(Boolean).join("\n"),
        command,
        cwd
      };
    }

    case "item/fileChange/requestApproval": {
      const itemId = str("itemId") ?? uuidv7();
      const turnId = str("turnId") ?? itemId;
      return {
        approvalId: `${itemId}:file-change`,
        turnId,
        itemId,
        kind: "file_change" as const,
        title: "Approve file changes",
        summary: str("reason") ?? "The runtime wants to modify files.",
        command: null,
        cwd: null
      };
    }

    case "item/permissions/requestApproval": {
      const itemId = str("itemId") ?? uuidv7();
      const turnId = str("turnId") ?? itemId;
      return {
        approvalId: `${itemId}:permissions`,
        turnId,
        itemId,
        kind: "permissions" as const,
        title: "Approve additional permissions",
        summary: str("reason") ?? "The runtime requested additional permissions.",
        command: null,
        cwd: null
      };
    }

    default:
      return null;
  }
}

const ITEM_PROTOCOL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);

export function respondToApprovalRequest(
  process: ApprovalResponseProcess,
  approval: PendingApprovalRecord,
  decision: RuntimeApprovalDecision
): void {
  const isApproved = decision === "approve";

  if (ITEM_PROTOCOL_METHODS.has(approval.method)) {
    process.sendResponse(approval.requestId, {
      decision: isApproved ? "accept" : "decline"
    });
    return;
  }

  if (approval.method === "item/permissions/requestApproval") {
    if (isApproved) {
      process.sendResponse(approval.requestId, { permissions: {} });
    } else {
      process.sendError(approval.requestId, -32001, "Permission request declined.");
    }
    return;
  }

  process.sendError(approval.requestId, -32601, "Unsupported approval request.");
}
