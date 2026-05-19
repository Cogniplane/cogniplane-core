// Severity tiers for Claude SDK tool names. The tiers drive both approval
// classification (file_change vs. command_execution) and the
// `autoApproveReadOnlyTools` gate. Keep this module as the single source of
// truth so a reviewer can't silently re-tier a tool by editing a caller.
//
// Invariants:
//  - Bash is intentionally NOT read-only — shell commands can be destructive.
//  - WebFetch is not a Claude native tool (the SDK uses WebSearch instead).
//  - Anything not explicitly read-only or file-changing falls through to
//    `command_execution`, which always goes through the approval flow.

export type ToolSeverity = "read_only" | "file_change" | "command_execution";

const READ_ONLY_TOOLS = new Set<string>(["Read", "Glob", "Grep", "WebSearch", "View"]);
const FILE_CHANGE_TOOLS = new Set<string>(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

export function classifyToolSeverity(toolName: string): ToolSeverity {
  if (READ_ONLY_TOOLS.has(toolName)) return "read_only";
  if (FILE_CHANGE_TOOLS.has(toolName)) return "file_change";
  return "command_execution";
}
