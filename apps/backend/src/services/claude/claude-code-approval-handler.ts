import type { RuntimeApprovalDecision, RuntimeApprovalKind } from "../../runtime-contracts.js";
import { classifyToolSeverity } from "../tool-classification.js";
import { uuidv7 } from "../../lib/uuid.js";

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type ClaudeApprovalEvent = {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  kind: RuntimeApprovalKind;
};

type DeferredApproval = {
  resolve: (result: PermissionResult) => void;
  toolName: string;
  toolInput: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
};

const MAX_PENDING_APPROVALS_PER_SESSION = 5;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * Strips the `mcp__<server>__` prefix from a Claude SDK tool name to get the
 * underlying managed-tool catalog name. Returns null when the shape doesn't
 * match (e.g. unexpected server name formats or non-MCP tools).
 */
function extractManagedToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return rest.slice(sep + 2);
}

export class ClaudeApprovalHandler {
  private readonly pendingApprovals = new Map<string, DeferredApproval>();
  private listener: ((event: ClaudeApprovalEvent) => void) | null = null;
  private autoApproveReadOnly = false;
  private toolContextId: string | null = null;
  private bypass = false;
  private readOnlyManagedToolNames: Set<string> = new Set();
  // Codex equivalent: ActiveTurnState.autoApprovedKinds in runtime-request-handler.ts — keep both in sync.
  private autoApprovedKindsForTurn: Set<RuntimeApprovalKind> = new Set();
  private approvalTtlMs = DEFAULT_APPROVAL_TTL_MS;

  /** Wall-clock TTL for pending approvals. Mirrors APPROVAL_REQUEST_TTL_MS on the Codex path. */
  setApprovalTtlMs(ms: number): void {
    if (ms > 0) this.approvalTtlMs = ms;
  }

  setAutoApproveReadOnly(enabled: boolean): void {
    this.autoApproveReadOnly = enabled;
  }

  /**
   * Names of managed MCP tools that are read-only (no side effects).
   * Expected names are the catalog names without the `mcp__<server>__` prefix,
   * e.g. `session_context`, `list_artifacts`. Used to auto-approve read-only
   * MCP calls when the runtime policy has `autoApproveReadOnlyTools: true`.
   * MCP tools not in this set always go through the approval flow (unless
   * bypass is on) — safe default for proxy/forwarded tools whose side-effect
   * profile the runtime cannot introspect.
   */
  setReadOnlyManagedToolNames(names: Iterable<string>): void {
    this.readOnlyManagedToolNames = new Set(names);
  }

  /** When set, every approve-allow result injects toolContextId into MCP tool inputs. */
  setToolContextId(id: string | null): void {
    this.toolContextId = id;
  }

  /** When true, canUseTool auto-approves every call (used when approvalPolicy = "never"). */
  setBypass(enabled: boolean): void {
    this.bypass = enabled;
  }

  /** Clear per-turn remembered approvals. Call at the start of each new turn. */
  clearAutoApprovedKindsForTurn(): void {
    this.autoApprovedKindsForTurn.clear();
  }

  onApprovalRequired(fn: (event: ClaudeApprovalEvent) => void): void {
    this.listener = fn;
  }

  classifyToolKind(toolName: string): RuntimeApprovalKind {
    return classifyToolSeverity(toolName) === "file_change" ? "file_change" : "command_execution";
  }

  /**
   * Ensures the per-turn `toolContextId` is threaded into managed MCP tool
   * arguments before the SDK forwards them. The Claude SDK has no direct way
   * to inject arguments — `canUseTool` → `updatedInput` is the only hook.
   */
  private enrichInput(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
    if (!this.toolContextId) return toolInput;
    if (!toolName.startsWith("mcp__")) return toolInput;
    if (typeof toolInput.toolContextId === "string" && toolInput.toolContextId) return toolInput;
    return { ...toolInput, toolContextId: this.toolContextId };
  }

  async canUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal: AbortSignal }
  ): Promise<PermissionResult> {
    // Auto-approve read-only tools when the runtime policy allows it
    if (this.autoApproveReadOnly && classifyToolSeverity(toolName) === "read_only") {
      return { behavior: "allow", updatedInput: this.enrichInput(toolName, toolInput) };
    }

    // Bypass mode: auto-allow everything (still inject toolContextId)
    if (this.bypass) {
      return { behavior: "allow", updatedInput: this.enrichInput(toolName, toolInput) };
    }

    // Auto-approve known-read-only managed MCP tools when the capability
    // profile permits it. Write-mode managed tools and all proxy tools fall
    // through to the normal approval prompt flow — the runtime is the only
    // approval boundary for those (the gateway intentionally lets destructive
    // managed calls through at the route layer, expecting the runtime to
    // gate them).
    if (toolName.startsWith("mcp__")) {
      if (this.autoApproveReadOnly) {
        const suffix = extractManagedToolName(toolName);
        if (suffix && this.readOnlyManagedToolNames.has(suffix)) {
          return { behavior: "allow", updatedInput: this.enrichInput(toolName, toolInput) };
        }
      }
      // Fall through to the approval flow below.
    }

    if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS_PER_SESSION) {
      return {
        behavior: "deny",
        message: `Approval rate limit reached: at most ${MAX_PENDING_APPROVALS_PER_SESSION} approvals may be pending per session at once.`
      };
    }

    const approvalId = uuidv7();
    const kind = this.classifyToolKind(toolName);

    // If the user already approved this kind for the current turn, auto-approve.
    if (this.autoApprovedKindsForTurn.has(kind)) {
      return { behavior: "allow", updatedInput: this.enrichInput(toolName, toolInput) };
    }

    return new Promise<PermissionResult>((resolve) => {
      // Wall-clock TTL: covers cases where no abort signal is delivered (closed
      // tab, instance still alive). Independent of options.signal.
      const timer = setTimeout(() => {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending) return;
        clearTimeout(pending.timer ?? undefined);
        this.pendingApprovals.delete(approvalId);
        resolve({ behavior: "deny", message: "Approval request timed out." });
      }, this.approvalTtlMs);

      this.pendingApprovals.set(approvalId, { resolve, toolName, toolInput, timer });

      // If the SDK aborts (e.g. timeout), deny and clean up so the promise
      // doesn't hang forever in the pendingApprovals map.
      if (options.signal) {
        const onAbort = () => {
          const pending = this.pendingApprovals.get(approvalId);
          if (!pending) return;
          clearTimeout(pending.timer ?? undefined);
          this.pendingApprovals.delete(approvalId);
          resolve({ behavior: "deny", message: "Aborted." });
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.listener?.({ approvalId, toolName, toolInput, kind });
    });
  }

  resolveApproval(approvalId: string, decision: RuntimeApprovalDecision, rememberForTurn?: boolean): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    if (pending.timer) clearTimeout(pending.timer);
    this.pendingApprovals.delete(approvalId);
    if (decision === "approve") {
      if (rememberForTurn) {
        this.autoApprovedKindsForTurn.add(this.classifyToolKind(pending.toolName));
      }
      pending.resolve({
        behavior: "allow",
        updatedInput: this.enrichInput(pending.toolName, pending.toolInput)
      });
    } else {
      pending.resolve({ behavior: "deny", message: "User denied permission." });
    }
    return true;
  }

  clearAll(): void {
    for (const [, pending] of this.pendingApprovals) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", message: "Session ended." });
    }
    this.pendingApprovals.clear();
  }

  get pendingCount(): number {
    return this.pendingApprovals.size;
  }
}
