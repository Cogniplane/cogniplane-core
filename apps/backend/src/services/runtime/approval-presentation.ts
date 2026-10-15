import { redactSecrets } from "../redact-secrets.js";
import type { ApprovalRequest } from "./approval-coordinator.js";

function cleanDisplay(value: string): string {
  return redactSecrets(value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").normalize("NFC")).trim();
}

function boundDisplay(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length > limit ? `${points.slice(0, limit - 3).join("")}...` : value;
}

export function approvalPresentation(
  action: ApprovalRequest,
  projectId: string | null
): { title: string; summary: string } {
  const { args, server, policyApproval } = action;
  const eligible = action.name === "write_artifact" && action.kind === "mcp_tool" &&
    server?.mode === "managed" && projectId === null &&
    typeof args.name === "string" && typeof args.content === "string" && args.content.length > 0 &&
    !Object.hasOwn(args, "filePath") &&
    (!policyApproval || (policyApproval.serverId === server.id && policyApproval.toolName === action.name));
  const name = eligible ? cleanDisplay(args.name as string) : "";
  if (!name) return { title: `Approve ${action.name}`, summary: JSON.stringify(redactSecrets(args)) };

  const reason = policyApproval
    ? cleanDisplay(policyApproval.explanation.replace(/\s+/gu, " ")) || "Policy Center requires approval."
    : "This tool requires approval.";
  const bytes = Buffer.byteLength(args.content as string, "utf8");
  return {
    title: `Save ${JSON.stringify(boundDisplay(name, 120))} to Artifacts`,
    summary: `The agent wants to save ${bytes} bytes of inline text as a file in this chat. ` +
      "If saved, you can open or download it from the Artifacts panel. " +
      `Reason: ${boundDisplay(reason, 300)}`
  };
}
