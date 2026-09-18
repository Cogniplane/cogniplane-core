import { SessionStore } from "../services/session-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { describe, expect, test } from "vitest";

import { ActivationTracker } from "../services/activation-tracker.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { MessageStore } from "../services/message-store.js";
import { DeepAgentsRuntimeAdapter } from "../services/deep-agents/deep-agents-runtime-adapter.js";
import type { DeepAgentsRuntimeFactory } from "../services/deep-agents/deep-agents-types.js";
import type { RuntimeConfigBundle } from "../services/admin-config-records.js";
import { gatherSkillCorpus } from "../services/skills/skill-improvement-corpus.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedMessage, seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("runtime activation attribution", () => {
  test("a new runtime turn makes skill usage countable and eligible for the corpus", async () => {
    const tenant = await seedTenantGraph();
    const tracker = new ActivationTracker(appPool());
    const messages = new MessageStore(appPool());
    const skill: RuntimeConfigBundle["skills"][number] = {
      id: "integration-writer", name: "Writer", description: "Write files", instructions: "Use write_artifact",
      associatedToolIds: ["write_artifact"], version: 1, hash: "h", revisionId: null,
      bundleHash: null, sourceType: "inline", bundleName: null, bundleStorageUri: null,
      validationStatus: null, reviewStatus: null
    };
    const context = { tenantId: tenant.tenantId, sessionId: tenant.sessionId, messageId: tenant.messageId };
    const factory: DeepAgentsRuntimeFactory = () => ({
      setApprovalSettings() {},
      async getAgentForModel() {
        return {
          async *streamEvents() {
            // This is the gateway's attribution call at tool execution time.
            // Its SQL must discover the runtime's real persisted availability row.
            expect(await tracker.recordSkillInvocationsForTool(context, "write_artifact")).toEqual([skill.id]);
            yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "Done" } } };
            yield { event: "on_chat_model_end", metadata: {} };
          }
        };
      },
      async getPendingActions() { return []; },
      buildResumeInput() { throw new Error("No approvals in this fixture"); },
      getMcpToolNames() { return new Set(["write_artifact"]); },
      getMcpToolServers() { return new Map([["write_artifact", "artifacts"]]); },
      async refreshCapabilities() {},
      async dispose() {}
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      createTestConfig(),
      {
        async compileRuntimeConfig() {
          return {
            runtimePolicy: testRuntimePolicy, skills: [skill], mcpServers: [], hash: "h",
            sources: { runtimePolicy: { id: "test", version: 1, hash: "h" }, skills: [], mcpServers: [] }
          };
        }
      },
      createSilentLogger(),
      {
        sessions: new SessionStore(appPool()), executions: new SessionExecutionStore(appPool()),
        approvals: new ApprovalStore(appPool()), auditEvents: new AuditEventStore(appPool()),
        activationTracker: tracker, tenantMembers: { async isUserBetaTester() { return false; } }
      },
      undefined,
      factory
    );
    const corpusInput = {
      tenantId: tenant.tenantId, userId: tenant.userId,
      skill: { skillId: skill.id, skillName: skill.name, description: skill.description, instructions: skill.instructions }
    };
    const corpusDeps = {
      db: appPool(),
      async loadMessagesForSession(tenantId: string, sessionId: string, userId: string) {
        return (await messages.listBySession(tenantId, sessionId, userId)).messages;
      }
    };
    try {
      expect((await gatherSkillCorpus(corpusDeps, corpusInput)).sessionsConsidered).toEqual([]);
      const session = await adapter.createSession({
        tenantId: tenant.tenantId, sessionId: tenant.sessionId, userId: tenant.userId
      });
      const events = [];
      for await (const event of adapter.runMessageAGUI(session, {
        prompt: "Write a file", toolContextId: "context", assistantMessageId: tenant.messageId
      })) events.push(event);
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect((await tracker.countSkillActivations(tenant.tenantId, 60_000)).get(skill.id)).toEqual({
        materializedSessions: 1, invokedSessions: 1
      });
      expect((await tracker.countMcpServerActivations(tenant.tenantId, 60_000)).get("artifacts")?.materializedSessions).toBe(1);
      expect((await gatherSkillCorpus(corpusDeps, corpusInput)).sessionsConsidered).toEqual([tenant.sessionId]);
    } finally {
      await adapter.close();
    }
  });

  test("changed or disabled skills cannot receive credit from previous turns", async () => {
    const tenant = await seedTenantGraph();
    const tracker = new ActivationTracker(appPool());
    const secondMessageId = await seedMessage(tenant.tenantId, tenant.userId, tenant.sessionId);
    const firstTurn = { tenantId: tenant.tenantId, sessionId: tenant.sessionId, messageId: tenant.messageId };
    const secondTurn = { ...firstTurn, messageId: secondMessageId };
    await tracker.recordMaterialization(firstTurn, [
      { resourceType: "skill", resourceId: "disabled", metadata: { associatedToolIds: ["old_tool"] } },
      { resourceType: "skill", resourceId: "changed", metadata: { associatedToolIds: ["old_tool"] } }
    ]);
    await tracker.recordMaterialization(secondTurn, [
      { resourceType: "skill", resourceId: "changed", metadata: { associatedToolIds: ["new_tool"] } }
    ]);
    expect(await tracker.recordSkillInvocationsForTool(secondTurn, "old_tool")).toEqual([]);
    expect(await tracker.recordSkillInvocationsForTool(secondTurn, "new_tool")).toEqual(["changed"]);
    // Missing IDs are an explicit legacy scope, never a wildcard over turns.
    const legacy = { tenantId: tenant.tenantId, sessionId: tenant.sessionId };
    expect(await tracker.recordSkillInvocationsForTool(legacy, "old_tool")).toEqual([]);
    await tracker.recordMaterialization(legacy, [
      { resourceType: "skill", resourceId: "legacy", metadata: { associatedToolIds: ["old_tool"] } }
    ]);
    expect(await tracker.recordSkillInvocationsForTool(legacy, "old_tool")).toEqual(["legacy"]);
    expect(await tracker.recordSkillInvocationsForTool(secondTurn, "old_tool")).toEqual([]);
    const counts = await tracker.countSkillActivations(tenant.tenantId, 60_000);
    expect(counts.get("disabled")?.invokedSessions).toBe(0);
    expect(counts.get("changed")?.invokedSessions).toBe(1);
  });

});
