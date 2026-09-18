import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import cors from "@fastify/cors";
import { CORS_ALLOWED_METHODS } from "../lib/cors.js";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { EventType, type BaseEvent } from "@ag-ui/client";

import type { RuntimeAdapter, RuntimeUserInput } from "../runtime-contracts.js";
import { SESSION_TRASH_RETENTION_DAYS } from "@cogniplane/shared-types";
import type { AppConfig } from "../config.js";
import type { Pool } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import type { ToolExecutionContext } from "../services/auth/tool-execution-context-store.js";
import type { ApprovalRecord } from "../services/auth/approval-store.js";
import type { ArtifactDetail, ArtifactDownloadTokenRecord, ArtifactPiiDetail, ArtifactRecord, ArtifactStore } from "../services/artifacts/artifact-store.js";
import { LocalArtifactStorage } from "../services/artifacts/artifact-storage.js";
import type { SessionRecord } from "../services/session-store.js";
import { SessionUploadAccessError } from "../services/session-upload-access.js";
import type { MessageRecord, ToolResultRecord, MessageStore } from "../services/message-store.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { MemoryStore } from "../services/memory-store.js";
import { RequestLimits } from "../services/request-limits.js";
import { FakeDatabase } from "./fake-database.js";
import { InMemoryAuditEventStore } from "./in-memory-audit-events.js";
import { testRuntimePolicy } from "./test-runtime-policy.js";
import { createTestConfig } from "./test-config.js";
import { registerApprovalRoutes, type ApprovalRouteStores } from "../routes/approvals.js";
import { registerArtifactRoutes, type ArtifactRouteStores } from "../routes/artifacts.js";
import { registerHealthRoutes, type HealthRouteStores } from "../routes/health.js";
import { registerMcpRoutes, type McpRouteStores } from "../routes/mcp.js";
import { ProxyToolMetadataCache } from "../services/mcp/proxy-tool-metadata-cache.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../services/managed-tools/factory.js";
import { runtimeTokenSecret } from "../lib/derived-secrets.js";
import type { ManagedToolDefinition } from "../services/managed-tools/types.js";
import { registerBuiltinManagedTools } from "../services/managed-tools/register-builtin-managed-tools.js";

type ScriptedAgentEvent = {
  type: string;
  responseId?: string;
  message?: string;
  delta?: string;
  toolCall?: {
    itemId: string;
    toolName?: string | null;
    title: string;
    input?: string;
    output?: string;
    server?: string | null;
    command?: string | null;
    kind?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// Tests that exercise the MCP route or managed-tool catalog get a fresh
// pair of registries with the built-in factories pre-registered. Tests that
// need additional tool factories (e.g. private overlays) construct their
// own pair separately.
function makeTestManagedToolRegistries(extraTools: readonly ManagedToolDefinition[] = []): {
  catalog: ManagedToolCatalog;
  factoryRegistry: ManagedToolFactoryRegistry;
} {
  const catalog = new ManagedToolCatalog();
  const factoryRegistry = new ManagedToolFactoryRegistry();
  registerBuiltinManagedTools(catalog, factoryRegistry);

  // Test-only tools. A test needs a handler whose OUTPUT it controls — the
  // built-ins all derive theirs from store state — to exercise what the
  // gateway does to a tool result on its way to the model.
  if (extraTools.length > 0) {
    catalog.register(
      extraTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        tenantConfigurable: true
      }))
    );
    // One factory key for all of them — a factory produces a LIST of tool
    // definitions, and the key is a domain, not a tool name.
    factoryRegistry.register("test-extras", () => [...extraTools]);
  }

  return { catalog, factoryRegistry };
}
import { registerMessageRoutes, type MessageRouteStores } from "../routes/messages.js";
import { registerModelRoutes, type ModelRouteStores } from "../routes/models.js";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";


class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  getRetentionDays(): number {
    return SESSION_TRASH_RETENTION_DAYS;
  }

  async list(
    _tenantId: string,
    userId: string,
    options: { purposes?: string[] | "all"; status?: "active" | "archived" } = {}
  ): Promise<SessionRecord[]> {
    const purposes = options.purposes;
    const includeAll = purposes === "all";
    const purposeFilter = includeAll
      ? null
      : Array.isArray(purposes) && purposes.length > 0
        ? new Set(purposes)
        : new Set(["normal"]);
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.status === (options.status ?? "active"))
      .filter((session) => purposeFilter === null || purposeFilter.has(session.purpose ?? "normal"))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(
    _tenantId: string,
    userId: string,
    sessionName: string,
    options: { purpose?: string } = {}
  ): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      sessionId: uuidv7(),
      userId,
      sessionName,
      status: "active",
      purpose: options.purpose ?? "normal",
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async getReadable(tenantId: string, sessionId: string, userId: string) {
    const session = await this.getOwned(tenantId, sessionId, userId);
    return session?.status !== "deleted" ? session : null;
  }

  async getOwned(_tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session && session.userId === userId ? session : null;
  }

  async requireUploadAccess(tenantId: string, sessionId: string, userId: string) {
    const session = await this.getOwned(tenantId, sessionId, userId);
    if (!session || session.status !== "active") throw new SessionUploadAccessError();
    return session.projectId ?? null;
  }

  async rename(_tenantId: string, sessionId: string, userId: string, sessionName: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status !== "active") {
      return null;
    }
    const updated = { ...session, sessionName, updatedAt: new Date().toISOString() };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async renameIfCurrent(
    _tenantId: string,
    sessionId: string,
    userId: string,
    expectedCurrentName: string,
    newName: string
  ): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.status !== "active" ||
      session.sessionName !== expectedCurrentName
    ) {
      return null;
    }
    const updated = { ...session, sessionName: newName, updatedAt: new Date().toISOString() };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async setArchived(tenantId: string, sessionId: string, userId: string, archived: boolean): Promise<SessionRecord | null> {
    const session = await this.getOwned(tenantId, sessionId, userId);
    if (!session || session.status !== (archived ? "active" : "archived")) return null;
    const now = new Date().toISOString();
    const updated: SessionRecord = { ...session, status: archived ? "archived" : "active", updatedAt: now };
    if (archived) updated.archivedAt = now;
    else delete updated.archivedAt;
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async remove(_tenantId: string, sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status === "deleted") {
      return false;
    }
    const now = new Date().toISOString();
    this.sessions.set(sessionId, { ...session, status: "deleted", deletedAt: now, updatedAt: now });
    return true;
  }

  async restoreDeleted(_tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status !== "deleted") return null;
    const updated = { ...session, status: "active" as const, updatedAt: new Date().toISOString() };
    delete updated.deletedAt;
    this.sessions.set(sessionId, updated);
    return updated;
  }
}

class InMemoryMessageStore {
  private readonly messages: MessageRecord[] = [];
  private readonly toolResults = new Map<string, ToolResultRecord>();
  private nextId = 1;
  private nextToolId = 1;

  // Mirrors the real store's bounded contract: newest-N selection with a
  // `hasMore` flag (see MessageStore.listBySession).
  async listBySession(
    _tenantId: string,
    sessionId: string,
    userId: string,
    options: { limit?: number | null } = {}
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    const all = this.messages
      .filter((message) => message.sessionId === sessionId && message.userId === userId)
      .map((message) => ({
        ...message,
        toolResults: [...this.toolResults.values()].filter(
          (toolResult) => toolResult.messageId === message.messageId
        )
      }));
    const limit = options.limit === null ? null : options.limit ?? all.length;
    return {
      messages: limit == null ? all : all.slice(-limit),
      hasMore: limit != null && all.length > limit
    };
  }

  async getOwned(_tenantId: string, messageId: string, userId: string): Promise<MessageRecord | null> {
    return this.messages.find((message) => message.messageId === messageId && message.userId === userId) ?? null;
  }

  async create(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    role: "user" | "assistant" | "system";
    status: MessageRecord["status"];
    content: string;
    detail?: Record<string, unknown>;
  }): Promise<MessageRecord> {
    const now = new Date().toISOString();
    const message: MessageRecord = {
      id: this.nextId++,
      messageId: uuidv7(),
      sessionId: input.sessionId,
      userId: input.userId,
      role: input.role,
      status: input.status,
      content: input.content,
      reasoningContent: "",
      reasoningSegments: null,
      planContent: "",
      tokenUsage: null,
      modelName: null,
      costUsd: null,
      feedbackRating: null,
      detail: input.detail ?? {},
      toolResults: [],
      createdAt: now,
      updatedAt: now
    };
    this.messages.push(message);
    return message;
  }

  async setPiiDetail(_tenantId: string, messageId: string, pii: Record<string, unknown>): Promise<void> {
    const message = this.messages.find((entry) => entry.messageId === messageId);
    if (!message) return;
    const current = (message.detail.pii as Record<string, unknown> | undefined) ?? {};
    message.detail = { ...message.detail, pii: { ...current, ...pii } };
    message.updatedAt = new Date().toISOString();
  }

  async updateContent(_tenantId: string, messageId: string, userId: string, status: MessageRecord["status"], content: string) {
    const message = this.messages.find((entry) => entry.messageId === messageId && entry.userId === userId);
    if (!message) {
      return null;
    }
    message.status = status;
    message.content = content;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  async updateStreamingContent(
    _tenantId: string,
    messageId: string,
    userId: string,
    content: { reasoningContent?: string; planContent?: string }
  ): Promise<void> {
    const message = this.messages.find((entry) => entry.messageId === messageId && entry.userId === userId);
    if (!message) return;
    if (content.reasoningContent !== undefined) {
      message.reasoningContent = content.reasoningContent;
    }
    if (content.planContent !== undefined) {
      message.planContent = content.planContent;
    }
    message.updatedAt = new Date().toISOString();
  }

  async addTokenUsage(...args: Parameters<MessageStore["addTokenUsage"]>) {
    const [tenantId, messageId, userId, delta, modelName] = args;
    const message = await this.getOwned(tenantId, messageId, userId);
    if (!message) return null;
    const current = message.tokenUsage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    message.tokenUsage = {
      inputTokens: current.inputTokens + delta.inputTokens,
      cachedInputTokens: current.cachedInputTokens + delta.cachedInputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
      reasoningOutputTokens: current.reasoningOutputTokens + delta.reasoningOutputTokens,
      totalTokens: current.totalTokens + delta.totalTokens
    };
    message.modelName = modelName ?? null;
    return message.tokenUsage;
  }

  async setCostUsd(...args: Parameters<MessageStore["setCostUsd"]>) {
    const [tenantId, messageId, userId, costUsd] = args;
    const message = await this.getOwned(tenantId, messageId, userId);
    if (message) message.costUsd = costUsd;
  }

  async upsertToolResult(input: {
    toolResultId: string;
    messageId: string;
    sessionId: string;
    userId: string;
    kind: "command" | "mcp";
    title: string;
    status: ToolResultRecord["status"];
    command: string | null;
    cwd: string | null;
    server: string | null;
    toolName: string | null;
    input: string;
    output: string;
    exitCode: number | null;
    durationMs: number | null;
  }): Promise<ToolResultRecord> {
    const current = this.toolResults.get(input.toolResultId);
    const now = new Date().toISOString();
    const next: ToolResultRecord = current ?? {
      id: this.nextToolId++,
      toolResultId: input.toolResultId,
      messageId: input.messageId,
      sessionId: input.sessionId,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      status: input.status,
      command: input.command,
      cwd: input.cwd,
      server: input.server,
      toolName: input.toolName,
      input: input.input,
      output: input.output,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      textOffset: null,
      createdAt: now,
      updatedAt: now
    };
    next.title = input.title;
    next.status = input.status;
    next.command = input.command;
    next.cwd = input.cwd;
    next.server = input.server;
    next.toolName = input.toolName;
    next.input = input.input;
    next.output = input.output;
    next.exitCode = input.exitCode;
    next.durationMs = input.durationMs;
    next.updatedAt = now;
    this.toolResults.set(input.toolResultId, next);
    return next;
  }
}

class FakeRuntimeManager implements RuntimeAdapter {
  readonly id = "deep-agents";
  readonly busySessions = new Set<string>();
  readonly abortedSessions: Array<{ sessionId: string; userId: string }> = [];
  readonly resolvedApprovals: Array<{ approvalId: string; tenantId: string; userId: string; decision: string; rememberForTurn?: boolean }> = [];
  readonly runMessageInputs: Array<{
    sessionId: string;
    runtimeId: string;
    prompt: string;
    userInputs?: RuntimeUserInput[];
    toolContextId: string | null;
    assistantMessageId?: string | null;
    effort?: string;
    model?: string;
  }> = [];
  private readonly eventScripts = new Map<string, ScriptedAgentEvent[]>();

  queueEvents(sessionId: string, events: ScriptedAgentEvent[]): void {
    this.eventScripts.set(sessionId, events);
  }
  hasActiveTurn(sessionId: string): boolean { return this.busySessions.has(sessionId); }
  hasSession(_sessionId: string): boolean { return false; }
  hasRuntime(_sessionId: string, _runtimeId: string): boolean { return false; }
  async interruptTurn(input: { sessionId: string }) {
    return this.busySessions.delete(input.sessionId) ? "interrupted" as const : "no_active_turn" as const;
  }
  async purgeSessionData() {}
  async invalidateTenantRuntimes() { return []; }
  async invalidateRuntimesForIntegration() { return []; }
  async close() {}
  async statRuntimeFile() { return { sizeBytes: 0 }; }
  async createSession(input: { sessionId: string; userId: string }) {
    return { sessionId: input.sessionId, runtimeId: `runtime-${input.sessionId}`, runtimePolicy: testRuntimePolicy };
  }
  async getRuntimePolicyId(_tenantId: string): Promise<string> { return "tenant-settings:test-tenant"; }
  async *runMessageAGUI(session: { sessionId: string; runtimeId: string }, input: {
    prompt: string; userInputs?: RuntimeUserInput[]; toolContextId: string | null; assistantMessageId?: string | null; effort?: string; model?: string; onBeforeTurn?: () => Promise<void>;
  }): AsyncGenerator<BaseEvent> {
    if (input.onBeforeTurn) await input.onBeforeTurn();
    this.runMessageInputs.push({ sessionId: session.sessionId, runtimeId: session.runtimeId, ...input });
    let textMessageId: string | null = null;
    for (const event of this.eventScripts.get(session.sessionId) ?? []) {
      if (event.type === "response.created") {
        yield {
          type: EventType.RUN_STARTED,
          threadId: session.sessionId,
          runId: event.responseId
        } as BaseEvent;
        continue;
      }
      if (event.type === "response.completed") {
        yield {
          type: EventType.RUN_FINISHED,
          threadId: session.sessionId,
          runId: event.responseId
        } as BaseEvent;
        continue;
      }
      if (event.type === "response.failed") {
        yield { type: EventType.RUN_ERROR, message: event.message } as BaseEvent;
        continue;
      }
      if (event.type === "response.output_text.delta") {
        if (!textMessageId) {
          textMessageId = uuidv7();
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: textMessageId,
            role: "assistant"
          } as BaseEvent;
        }
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: textMessageId,
          delta: event.delta
        } as BaseEvent;
        continue;
      }
      if (event.type === "response.output_item.done" && textMessageId) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId: textMessageId } as BaseEvent;
        textMessageId = null;
        continue;
      }
      if (event.type === "response.tool.started") {
        const toolCall = event.toolCall;
        if (!toolCall) continue;
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall.itemId,
          toolCallName: toolCall.toolName ?? toolCall.title
        } as BaseEvent;
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall.itemId,
          delta: toolCall.input ?? "{}"
        } as BaseEvent;
        yield { type: EventType.TOOL_CALL_END, toolCallId: toolCall.itemId } as BaseEvent;
        if (toolCall.server || toolCall.command || toolCall.kind === "mcp") {
          yield {
            type: EventType.CUSTOM,
            name: "tool_meta",
            value: {
              toolCallId: toolCall.itemId,
              kind: toolCall.kind,
              server: toolCall.server,
              command: toolCall.command
            }
          } as BaseEvent;
        }
        continue;
      }
      if (event.type === "response.tool.completed") {
        const toolCall = event.toolCall;
        if (!toolCall) continue;
        yield {
          type: EventType.TOOL_CALL_RESULT,
          messageId: uuidv7(),
          toolCallId: toolCall.itemId,
          content: toolCall.output ?? "",
          role: "tool"
        } as BaseEvent;
      }
    }
  }
  async abortSession(input: { tenantId: string; sessionId: string; userId: string }) { this.abortedSessions.push(input); }
  async resolveApproval(input: { approvalId: string; tenantId: string; userId: string; decision: "approve" | "reject"; rememberForTurn?: boolean }) {
    this.resolvedApprovals.push(input);
    return "resolved" as const;
  }
  async readRuntimeFile(_sessionId: string, _filePath: string): Promise<Uint8Array> { return new Uint8Array(0); }
  async writeRuntimeFile(_sessionId: string, filePath: string, _data: Uint8Array | ArrayBuffer | string): Promise<string> { return filePath; }
  getHealthSnapshot() { return { activeRuntimeCount: 0, activeTurnCount: 0 }; }
}

class InMemoryToolContextStore {
  private readonly contexts = new Map<string, ToolExecutionContext>();
  readonly createdContexts: ToolExecutionContext[] = [];
  private nextId = 1;
  async create(input: {
    tenantId: string; sessionId: string; userId: string; runtimeId: string; runtimePolicyId: string; messageId: string | null; credentialEnvelope?: Record<string, unknown>; metadata?: Record<string, unknown>; ttlMs: number;
  }): Promise<ToolExecutionContext> {
    const now = new Date();
    const context: ToolExecutionContext = {
      toolContextId: `ctx_test-${this.nextId++}`,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: input.runtimeId,
      runtimePolicyId: input.runtimePolicyId,
      messageId: input.messageId,
      credentialEnvelope: input.credentialEnvelope ?? {},
      metadata: input.metadata ?? {},
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      createdAt: now.toISOString()
    };
    this.contexts.set(context.toolContextId, context);
    this.createdContexts.push(context);
    return context;
  }
  async require(_tenantId: string, toolContextId: string) {
    const context = this.contexts.get(toolContextId);
    if (!context) throw new Error("Missing tool context.");
    return context;
  }
  async findLatestActiveBySession(tenantId: string, sessionId: string) {
    const now = Date.now();
    let latest: ToolExecutionContext | null = null;
    for (const ctx of this.contexts.values()) {
      if (ctx.tenantId !== tenantId || ctx.sessionId !== sessionId) continue;
      if (new Date(ctx.expiresAt).getTime() <= now) continue;
      if (!latest || ctx.createdAt > latest.createdAt) latest = ctx;
    }
    return latest;
  }
}

class InMemoryApprovalStore {
  approvals: ApprovalRecord[] = [];
  async listPending(_tenantId: string, sessionId: string, _userId: string) { return this.approvals.filter((approval) => approval.sessionId === sessionId); }
  async get(tenantId: string, approvalId: string, userId: string) {
    return this.approvals.find(
      (approval) =>
        approval.tenantId === tenantId &&
        approval.approvalId === approvalId &&
        approval.userId === userId
    ) ?? null;
  }
}

class InMemoryArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly downloadTokens = new Map<string, ArtifactDownloadTokenRecord>();
  private nextId = 1;
  constructor(private readonly sessions: InMemorySessionStore) {}
  async createUpload(input: Parameters<ArtifactStore["createUpload"]>[0]) {
    await this.sessions.requireUploadAccess(input.tenantId, input.sessionId, input.userId);
    return this.create({ ...input, artifactType: "upload", createdByType: "user", status: "pending" });
  }
  async listForUser(..._args: Parameters<ArtifactStore["listForUser"]>): ReturnType<ArtifactStore["listForUser"]> {
    throw new Error("Configure listForUser for cross-session artifact tests; this fixture serves session artifacts.");
  }
  async create(input: {
    tenantId?: string; artifactType: ArtifactRecord["artifactType"]; sessionId: string; userId: string; sourceArtifactId?: string | null; artifactName: string; mimeType: string; storageBackend: ArtifactRecord["storageBackend"]; storageKey: string; fileSizeBytes: number; checksumSha256: string; status: ArtifactRecord["status"]; createdByType: ArtifactRecord["createdByType"]; createdByRef?: string | null; detail?: ArtifactDetail;
  }): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const artifact: ArtifactRecord = {
      id: this.nextId++, artifactId: uuidv7(), sessionId: input.sessionId, userId: input.userId,
      artifactType: input.artifactType, sourceArtifactId: input.sourceArtifactId ?? null,
      artifactName: input.artifactName, mimeType: input.mimeType, storageBackend: input.storageBackend,
      storageKey: input.storageKey, fileSizeBytes: input.fileSizeBytes, checksumSha256: input.checksumSha256,
      status: input.status, createdByType: input.createdByType, createdByRef: input.createdByRef ?? null,
      detail: input.detail ?? {}, createdAt: now, updatedAt: now
    };
    this.artifacts.set(artifact.artifactId, artifact);
    return artifact;
  }
  async createGenerated(input: Parameters<ArtifactStore["createGenerated"]>[0]) {
    await this.sessions.requireUploadAccess(input.tenantId, input.sessionId, input.userId);
    return this.create(input);
  }
  async listBySession(_tenantId: string, sessionId: string, userId: string) {
    return [...this.artifacts.values()].filter((artifact) => artifact.sessionId === sessionId && artifact.userId === userId && artifact.status !== "deleted");
  }
  async getReadable(tenantId: string, artifactId: string, userId: string) {
    const artifact = await this.getOwned(tenantId, artifactId, userId);
    return artifact?.status !== "deleted" ? artifact : null;
  }

  async getOwned(_tenantId: string, artifactId: string, userId: string) { const artifact = this.artifacts.get(artifactId); return artifact && artifact.userId === userId ? artifact : null; }
  async get(_tenantId: string, artifactId: string) { return this.artifacts.get(artifactId) ?? null; }
  async findLatestReadableDerived(_tenantId: string, sourceArtifactId: string, userId: string) {
    const candidates = [...this.artifacts.values()].filter((artifact) => artifact.userId === userId && artifact.sourceArtifactId === sourceArtifactId && artifact.status === "ready" && artifact.mimeType.startsWith("text/"));
    return candidates[candidates.length - 1] ?? null;
  }
  async update(_tenantId: string, artifactId: string, input: { status?: ArtifactRecord["status"]; detail?: ArtifactDetail }) {
    const artifact = this.artifacts.get(artifactId); if (!artifact) return null;
    const updated: ArtifactRecord = { ...artifact, status: input.status ?? artifact.status, detail: input.detail ?? artifact.detail, updatedAt: new Date().toISOString() };
    this.artifacts.set(artifactId, updated); return updated;
  }
  async setPiiDetail(_tenantId: string, artifactId: string, pii: ArtifactPiiDetail) {
    const artifact = this.artifacts.get(artifactId); if (!artifact) return;
    const current = (artifact.detail.pii as ArtifactPiiDetail | undefined) ?? {};
    const updated: ArtifactRecord = {
      ...artifact,
      detail: { ...artifact.detail, pii: { ...current, ...pii } },
      updatedAt: new Date().toISOString()
    };
    this.artifacts.set(artifactId, updated);
  }
  async createDownloadToken(input: { tenantId?: string; artifactId: string; sessionId: string; userId: string; storageBackend: ArtifactRecord["storageBackend"]; storageKey: string; fileName: string; contentType: string; ttlMs: number; }): Promise<ArtifactDownloadTokenRecord> {
    const now = Date.now();
    const record: ArtifactDownloadTokenRecord = { token: `download-${this.downloadTokens.size + 1}`, tenantId: input.tenantId ?? "test-tenant", artifactId: input.artifactId, sessionId: input.sessionId, userId: input.userId, storageBackend: input.storageBackend, storageKey: input.storageKey, fileName: input.fileName, contentType: input.contentType, expiresAt: new Date(now + input.ttlMs).toISOString(), createdAt: new Date(now).toISOString() };
    this.downloadTokens.set(record.token, record); return record;
  }
  // Shared identity + artifact/session gating for peek and consume so the two
  // paths can never diverge. Identity gating (tenant + user, with admin bypass)
  // lives here so an unauthorized request never observes or consumes the token.
  // Deliberately does NOT filter on expiry — the route surfaces expiry as a
  // distinct 410 via the peeked record.
  private async resolveGatedDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }): Promise<ArtifactDownloadTokenRecord | null> {
    const downloadToken = this.downloadTokens.get(input.token);
    if (!downloadToken) return null;
    if (downloadToken.tenantId !== input.requesterTenantId) return null;
    if (!input.callerIsAdmin && downloadToken.userId !== input.requesterUserId) return null;
    const artifact = this.artifacts.get(downloadToken.artifactId);
    const session = await this.sessions.getOwned(downloadToken.tenantId, downloadToken.sessionId, downloadToken.userId);
    if (!artifact || artifact.status === "deleted" || !session || session.status !== "active") {
      return null;
    }
    if (artifact.artifactType !== "upload" && artifact.status !== "ready") {
      return null;
    }
    return downloadToken;
  }

  // Non-consuming lookup used by GET /downloads/:token to validate the token
  // and open the storage stream before committing the single-use consume.
  // Returns the row (regardless of expiry) on the same gating as consume.
  async peekDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }) {
    return this.resolveGatedDownloadToken(input);
  }

  // Mirrors production single-use semantics: returns the row only on the
  // first call AND only when caller identity matches; subsequent calls return
  // null. An expired token is never consumed.
  async consumeDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }) {
    const downloadToken = await this.resolveGatedDownloadToken(input);
    if (!downloadToken) return null;
    if (new Date(downloadToken.expiresAt).getTime() <= Date.now()) return null;
    this.downloadTokens.delete(input.token);
    return downloadToken;
  }
}

class NoopArtifactProcessor {
  async extractArtifactText(artifact: ArtifactRecord): Promise<string | null> { return artifact.mimeType !== "application/pdf" ? null : "Extracted PDF text for testing."; }
}

type TestAppPiiOptions = {
  piiProtection?: MessageRouteStores["piiProtection"];
  piiScanRuns?: MessageRouteStores["piiScanRuns"];
};

/**
 * The secret the test app's MCP gateway verifies runtime tokens with. Derived
 * from the test config the same way production derives from the real one, so a
 * test that mints with this exercises the actual key relationship rather than
 * a shared literal.
 */
export const TEST_RUNTIME_TOKEN_SECRET = runtimeTokenSecret(
  createTestConfig().DATA_ENCRYPTION_SECRET
);

export async function createTestApp(
  configOverrides: Partial<AppConfig> & {
    proxyUpstreamUrl?: string;
    /** Extra managed tools registered on `managed-session-context`, for tests
     * that need to control a handler's return value. */
    extraManagedTools?: readonly ManagedToolDefinition[];
    pii?: TestAppPiiOptions;
    showEffortSelector?: boolean;
    // Override the Policy Center gate at the MCP route. Defaults to a no-rules
    // stub (every action allows). Pass a real PolicyService to exercise policy
    // enforcement through the gateway.
    policyService?: McpRouteStores["policyService"];
    activationTracker?: McpRouteStores["activationTracker"];
  } = {}
) {
  const {
    proxyUpstreamUrl,
    extraManagedTools,
    pii,
    showEffortSelector,
    policyService: policyServiceOverride,
    activationTracker,
    ...appConfigOverrides
  } = configOverrides;
  const db = new FakeDatabase();
  const sessions = new InMemorySessionStore();
  const messages = new InMemoryMessageStore();
  const runtimeManager = new FakeRuntimeManager();
  const activeTurns = new ActiveTurnsRegistry();
  const toolContexts = new InMemoryToolContextStore();
  const approvals = new InMemoryApprovalStore();
  const artifacts = new InMemoryArtifactStore(sessions);
  const auditEvents = new InMemoryAuditEventStore();
  const artifactProcessor = new NoopArtifactProcessor();
  const artifactStorageRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-core-artifact-tests-"));
  const artifactStorage = new LocalArtifactStorage(artifactStorageRoot);
  const config = createTestConfig({ ARTIFACT_STORAGE_ROOT: artifactStorageRoot, ...appConfigOverrides });
  const app = Fastify({ bodyLimit: config.MAX_REQUEST_BODY_BYTES });
  const limits = RequestLimits.fromAppConfig(config);
  app.decorate("config", config);
  const pool = db as unknown as Pool;
  app.decorate("db", pool);
  await app.register(cors, { origin: config.API_ORIGIN, methods: CORS_ALLOWED_METHODS, allowedHeaders: ["Content-Type", "X-User-Id", "X-Tenant-Id"] });
  await app.register(multipart, {
    limits: { fileSize: config.ARTIFACT_MAX_UPLOAD_BYTES, files: 1 }
  });
  app.addHook("preHandler", async (request) => {
    const userId = request.headers["x-user-id"]?.toString() || "test-user";
    const isAdmin = config.ADMIN_USER_IDS.includes(userId);
    request.auth = {
      userId,
      tenantId: request.headers["x-tenant-id"]?.toString() || "test-tenant",
      isAdmin,
      role: isAdmin ? ("owner" as const) : ("member" as const)
    };
  });
  await registerHealthRoutes(app, { deepAgentsAdapter: runtimeManager } satisfies HealthRouteStores);
  const fakeDynamicConfig: ModelRouteStores["dynamicConfig"] = {
    async getOrCreateTenantSettings() {
      return {
        tenantId: "test-tenant",
        showEffortSelector: showEffortSelector ?? false,
        webSearchMode: "disabled" as const,
        approvalPolicy: "on-request" as const,
        approvalReviewer: "user" as const,
        allowCommandExecution: false,
        autoApproveReadOnlyTools: true,
        policyEnforcementMode: "monitor" as const,
        developerInstructions: null,
        enabledToolIds: [
          "managed-session-context",
          "session_context",
          "list_artifacts",
          "read_text_artifact",
          "write_artifact"
        ],
        enabledMcpServerIds: ["managed-session-context"],
        enabledProviders: ["anthropic", "openai", "google", "openrouter", "zai"],
        enabledModelIds: null,
        modelDefaultEfforts: {},
        version: 1,
        configHash: "test-hash",
        updatedAt: new Date().toISOString()
      };
    }
  };
  await registerModelRoutes(app, {
    dynamicConfig: fakeDynamicConfig,
    configuredProviders: async () => new Set(["anthropic"])
  } satisfies ModelRouteStores);
  await registerSessionRoutes(app, {
    executions: { stop: async () => { throw new Error("Unexpected shared execution"); } },
    sessions,
    messages,
    runtimeAdapter: runtimeManager,
    limits,
    activeTurns,
    auditEvents
  } satisfies SessionRouteStores);
  await registerArtifactRoutes(app, {
    sessions,
    artifacts,
    auditEvents,
    storage: artifactStorage,
    processor: artifactProcessor,
    limits
  } satisfies ArtifactRouteStores);
  await registerMessageRoutes(app, {
    executions: {
      acquire: async () => { throw new Error("Unexpected shared execution"); },
      heartbeat: async () => { throw new Error("Unexpected shared execution"); },
      release: async () => { throw new Error("Unexpected shared execution"); },
    },
    projects: { getReadable: async () => null },
    sessions,
    artifacts,
    artifactProcessor,
    storage: artifactStorage,
    limits,
    messages,
    toolContexts,
    runtimeAdapter: runtimeManager,
    dynamicConfig: fakeDynamicConfig,
    customModels: { async list() { return []; } },
    hasProviderKey: async () => true,
    getTenantAnthropicApiKey: async () => null,
    activeTurns,
    auditEvents,
    piiProtection: pii?.piiProtection,
    piiScanRuns: pii?.piiScanRuns,
  } satisfies MessageRouteStores);
  await registerApprovalRoutes(app, {
    approvals,
    runtimeAdapter: runtimeManager
  } satisfies ApprovalRouteStores);
  const { factoryRegistry: managedToolFactoryRegistry, catalog: managedToolCatalog } =
    makeTestManagedToolRegistries(extraManagedTools);
  await registerMcpRoutes(app, {
    db: pool,
    memories: new MemoryStore(pool),
    dynamicConfig: {
      async listSkills() { return []; },
      async getMcpServer(_tenantId: string, serverId: string) {
        if (serverId === "managed-session-context") {
          return { id: "managed-session-context", description: "Managed session context", mode: "managed" as const, routePath: "/mcp/managed-session-context", upstreamUrl: null, transportKind: "http" as const, version: 1, hash: "hash-managed-session-context" };
        }
        return { id: serverId, description: "Test proxy", mode: "proxy" as const, routePath: `/mcp/${serverId}`, upstreamUrl: proxyUpstreamUrl ?? "https://example.com/mcp", transportKind: "http" as const, version: 1, hash: "hash-test-proxy" };
      }
    },
    sessions,
    messages,
    artifacts,
    storage: artifactStorage,
    limits,
    auditEvents,
    toolContexts,
    githubConnections: { async getRuntimeCredentials() { return null; } },
    notionConnections: { async getRuntimeCredentials() { return null; } },
    managedToolFactoryRegistry,
    managedToolCatalog,
    // Policy Center with no rules → every action evaluates to default-allow and
    // nothing is recorded. Tests that exercise rules pass a real PolicyService
    // via the `policyService` override.
    policyService: policyServiceOverride ?? {
      async gateAction() {
        return {
          evaluation: { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null },
          enforced: false
        };
      },
      async evaluate() {
        return { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null };
      }
    },
    approvals,
    projectFiles: {
      async readRuntimeSnapshotFile() {
        throw new Error("Unexpected project file read in route test");
      },
      async createAgentDraftFromContent() {
        throw new Error("Unexpected project file write in route test");
      },
      async readConflictContext() {
        throw new Error("Unexpected project conflict read in route test");
      },
      async readConflictMetadata() {
        throw new Error("Unexpected project conflict metadata read in route test");
      }
    },
    // Derive it exactly the way app-bootstrap does, from the same config the
    // test app already holds — not a literal. A literal here would let the
    // mint side (the adapter) and the verify side drift apart under a future
    // key-derivation change while the whole route suite stayed green.
    runtimeTokenSecret: runtimeTokenSecret(config.DATA_ENCRYPTION_SECRET),
    artifactMaxBytes: config.ARTIFACT_MAX_UPLOAD_BYTES,
    activationTracker,
    proxyToolMetadataCache: new ProxyToolMetadataCache()
  } satisfies McpRouteStores);
  app.addHook("onClose", async () => { await rm(artifactStorageRoot, { recursive: true, force: true }); });
  await app.ready();
  return { app, db, activeTurns, sessions, messages, runtimeManager, toolContexts, approvals, artifacts, auditEvents, artifactProcessor, limits };
}

export async function createTestToolContext(
  toolContexts: InMemoryToolContextStore,
  overrides: Partial<{ tenantId: string; sessionId: string; userId: string; runtimeId: string; runtimePolicyId: string; messageId: string | null; credentialEnvelope: Record<string, unknown>; metadata: Record<string, unknown>; ttlMs: number; }> = {}
) {
  return toolContexts.create({
    tenantId: overrides.tenantId ?? "test-tenant",
    sessionId: overrides.sessionId ?? "session-1",
    userId: overrides.userId ?? "test-user",
    runtimeId: overrides.runtimeId ?? "runtime-session-1",
    runtimePolicyId: overrides.runtimePolicyId ?? "tenant-settings:test-tenant",
    messageId: overrides.messageId ?? null,
    credentialEnvelope: overrides.credentialEnvelope,
    metadata: { runtimePolicy: testRuntimePolicy, ...(overrides.metadata ?? {}) },
    ttlMs: overrides.ttlMs ?? 60_000
  });
}
