// "Long-term memory" section, rendered into the deep-agents system prompt at
// session start so the agent knows memory exists — and sees recent items —
// without a tool call.

import type { FastifyBaseLogger } from "fastify";

import type { PolicyEnforcementMode } from "@cogniplane/shared-types";

import type { MemoryRecord, MemoryStore } from "./memory-store.js";
import type { PolicyService } from "./policy/policy-service.js";

/**
 * Policy context for the injection read. The workspace injection is a memory
 * READ that happens outside the MCP gateway, so it must honor the same Policy
 * Center rules that would gate a `memory_search` tool call — otherwise a
 * tenant's block/require_approval rule on memory reads is bypassed at prompt
 * time.
 */
export type MemoryReadPolicy = {
  policy: Pick<PolicyService, "evaluate">;
  enforcementMode: PolicyEnforcementMode;
};

/** How many memories are surfaced into the workspace context at session start. */
export const WORKSPACE_MEMORY_LIMIT = 10;

const EXCERPT_LENGTH = 200;

// Per-tool doc bullets: only the tools actually enabled for the tenant are
// advertised, so the section never instructs the agent to call a tool the
// gateway will reject.
const MEMORY_TOOL_DOCS: ReadonlyArray<{ toolId: string; line: string }> = [
  {
    toolId: "memory_search",
    line: "- `memory_search` — search saved memories before asking the user for context you might already have."
  },
  {
    toolId: "memory_save",
    line: "- `memory_save` — save durable facts, preferences, and decisions worth keeping (short kebab-case `name`, concise `content`)."
  },
  {
    toolId: "memory_delete",
    line: "- `memory_delete` — remove a memory that is wrong or obsolete."
  }
];

function enabledMemoryToolDocs(enabledToolIds: string[]) {
  return MEMORY_TOOL_DOCS.filter((doc) => enabledToolIds.includes(doc.toolId));
}

function excerpt(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length > EXCERPT_LENGTH ? `${singleLine.slice(0, EXCERPT_LENGTH)}…` : singleLine;
}

/**
 * Best-effort fetch of the memories to inject at session start. Memory is a
 * convenience, never a boot dependency — any store failure degrades to "no
 * memories injected" rather than failing the runtime bootstrap.
 */
export async function loadWorkspaceMemories(
  memories: MemoryStore | undefined,
  input: {
    tenantId: string;
    userId: string;
    enabledToolIds: string[];
    readPolicy?: MemoryReadPolicy;
  },
  log?: FastifyBaseLogger
): Promise<MemoryRecord[]> {
  // Gate on memory_search specifically — it is the READ capability. A tenant
  // that enables only memory_save/memory_delete has chosen a write-only
  // posture, and injecting stored memory contents into the prompt would
  // bypass that. Those tenants still get the tool-doc section (below), just
  // no memory contents.
  if (!memories || !input.enabledToolIds.includes("memory_search")) return [];
  try {
    if (input.readPolicy && input.readPolicy.enforcementMode === "enforce") {
      // Same action facts the gateway derives for a memory_search call
      // (category = factory domain key, severity from readOnly). The session
      // will host both interactive and scheduled turns, so a rule gating
      // either context suppresses injection. Monitor mode never gates —
      // consistent with the gateway. evaluate() is side-effect-free; the
      // injection is a platform read, not a tool call, so no decision row or
      // approval prompt belongs here.
      for (const turnContext of ["interactive", "scheduled"] as const) {
        const evaluation = await input.readPolicy.policy.evaluate(input.tenantId, {
          toolName: "memory_search",
          category: "memory",
          severity: "read_only",
          serverId: null,
          turnContext
        });
        if (evaluation.gating) return [];
      }
    }
    return await memories.search(input.tenantId, input.userId, { limit: WORKSPACE_MEMORY_LIMIT });
  } catch (error) {
    log?.warn(
      { err: error, tenantId: input.tenantId, userId: input.userId },
      "failed to load long-term memories for workspace injection"
    );
    return [];
  }
}

/**
 * Markdown lines for the workspace memory section. Empty when no memory tool
 * is enabled for the tenant; only enabled tools are documented.
 */
export function buildMemorySectionLines(
  memories: MemoryRecord[],
  enabledToolIds: string[]
): string[] {
  const toolDocs = enabledMemoryToolDocs(enabledToolIds);
  if (toolDocs.length === 0) return [];

  const lines = [
    "## Long-term memory",
    "",
    "You have persistent long-term memory that survives across sessions:",
    "",
    ...toolDocs.map((doc) => doc.line),
    ""
  ];

  // Defense in depth: never render memory contents unless the read tool is
  // enabled, even if a caller passes memories it shouldn't have loaded.
  if (memories.length > 0 && enabledToolIds.includes("memory_search")) {
    lines.push("Recently saved memories:", "");
    for (const memory of memories) {
      lines.push(`- **${memory.slug}**: ${excerpt(memory.content)}`);
    }
    lines.push("");
  }

  return lines;
}
