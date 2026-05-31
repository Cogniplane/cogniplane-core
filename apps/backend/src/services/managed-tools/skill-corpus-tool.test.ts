import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { MessageStore } from "../message-store.js";
import type { PiiDecision, PiiProtectionService } from "../pii/pii-protection-service.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { createSkillCorpusTool } from "./skill-corpus-tool.js";

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: "rt",
    runtimePolicyId: "default",
    messageId: null,
    credentialEnvelope: {},
    metadata: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

// withTenantScope(db, tenantId, fn) calls fn(client); fetchInvokedSessionIds
// runs a single SELECT. Return no rows so the corpus renders its empty state
// without needing a real Postgres. `makeFakeDb` records every SQL string so a
// test can assert whether the activation query ran at all.
function makeFakeDb() {
  const queries: string[] = [];
  const db = {
    async connect() {
      return {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        release() {}
      };
    }
  } as unknown as Pool;
  return { db, queries };
}

const fakeDb = makeFakeDb().db;

function deps(
  skills: Array<{ skillId: string; skillName: string; description: string | null; instructions: string; isInherited?: boolean }>,
  options: { db?: Pool; piiProtection?: PiiProtectionService } = {}
) {
  return {
    db: options.db ?? fakeDb,
    dynamicConfig: {
      async listSkills() {
        return skills;
      }
    } as unknown as DynamicConfigService,
    messages: {
      async listBySession() {
        return [];
      }
    } as unknown as MessageStore,
    piiProtection: options.piiProtection
  };
}

function piiStub(decision: PiiDecision): PiiProtectionService {
  return {
    async evaluateText() {
      return decision;
    }
  } as unknown as PiiProtectionService;
}

const oneSkill = [
  {
    skillId: "write-artifact",
    skillName: "Write Artifact",
    description: "Writes files.",
    instructions: "Call write_artifact for generated files."
  }
];

function tool(d: Parameters<typeof createSkillCorpusTool>[0]) {
  return createSkillCorpusTool(d).find((t) => t.name === "read_skill_corpus")!;
}

test("read_skill_corpus is read-only and tenant-configurable metadata", () => {
  const def = tool(deps([]));
  expect(def.name).toBe("read_skill_corpus");
  expect(def.readOnly).toBe(true);
});

test("read_skill_corpus returns the corpus markdown + the skill's current SKILL.md", async () => {
  const def = tool(deps(oneSkill));

  const result = (await def.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", skillId: "write-artifact" }
  })) as Record<string, unknown>;

  expect(result.skillId).toBe("write-artifact");
  expect(result.skillName).toBe("Write Artifact");
  expect(typeof result.corpusMarkdown).toBe("string");
  // The current SKILL.md instructions are embedded in the corpus.
  expect(String(result.corpusMarkdown)).toContain("Call write_artifact for generated files.");
  expect(result.includedSessionCount).toBe(0);
});

test("read_skill_corpus throws for an unknown skill", async () => {
  const def = tool(deps([]));
  await expect(
    def.handler({ context: ctx(), arguments: { toolContextId: "ctx-1", skillId: "nope" } })
  ).rejects.toThrow(/not found/);
});

test("read_skill_corpus throws when skillId is missing", async () => {
  const def = tool(deps([]));
  await expect(
    def.handler({ context: ctx(), arguments: { toolContextId: "ctx-1" } })
  ).rejects.toThrow(/skillId is required/);
});

test("read_skill_corpus honors an explicit sessionCount: 0 (no activation query)", async () => {
  const { db, queries } = makeFakeDb();
  const def = tool(deps(oneSkill, { db }));

  const result = (await def.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", skillId: "write-artifact", sessionCount: 0 }
  })) as Record<string, unknown>;

  expect(result.includedSessionCount).toBe(0);
  // With sessionCount: 0 the corpus builder must not query resource_activations
  // (the old `|| 50` bug coerced 0 → 50 and pulled in history).
  expect(queries.some((sql) => sql.includes("resource_activations"))).toBe(false);
});

test("read_skill_corpus fails closed when PII protection blocks the corpus", async () => {
  const def = tool(
    deps(oneSkill, {
      piiProtection: piiStub({
        action: "block",
        findings: [],
        blockReason: "ssn",
        providerType: "rule",
        providerModel: null
      })
    })
  );

  await expect(
    def.handler({ context: ctx(), arguments: { toolContextId: "ctx-1", skillId: "write-artifact" } })
  ).rejects.toThrow(/blocked by PII protection/);
});

test("read_skill_corpus returns transformed text when PII protection transforms", async () => {
  const def = tool(
    deps(oneSkill, {
      piiProtection: piiStub({
        action: "transform",
        transformedText: "REDACTED CORPUS",
        findings: [],
        providerType: "rule",
        providerModel: null
      })
    })
  );

  const result = (await def.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", skillId: "write-artifact" }
  })) as Record<string, unknown>;

  expect(result.corpusMarkdown).toBe("REDACTED CORPUS");
});
