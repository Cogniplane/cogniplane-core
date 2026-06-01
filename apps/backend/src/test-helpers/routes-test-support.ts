import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";

import type { RuntimeEvent, RuntimeUserInput } from "../runtime-contracts.js";
import type { AppConfig } from "../config.js";
import type { Pool } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import type { ApprovalRecord } from "../services/auth/approval-store.js";
import type { ArtifactDetail, ArtifactDownloadTokenRecord, ArtifactPiiDetail, ArtifactRecord } from "../services/artifacts/artifact-store.js";
import { LocalArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { RequestLimits } from "../services/request-limits.js";
import { FakeDatabase } from "./fake-database.js";
import { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import { InMemoryAuditEventStore } from "./in-memory-audit-events.js";
import { phase4RuntimePolicy } from "./phase4-runtime-policy.js";
import { createTestConfig } from "./test-config.js";
import { registerApprovalRoutes, type ApprovalRouteStores } from "../routes/approvals.js";
import { registerArtifactRoutes, type ArtifactRouteStores } from "../routes/artifacts.js";
import { registerHealthRoutes, type HealthRouteStores } from "../routes/health.js";
import { registerMcpRoutes, type McpRouteStores } from "../routes/mcp.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../services/managed-tools/factory.js";
import { registerBuiltinManagedTools } from "../services/managed-tools/register-builtin-managed-tools.js";

// Tests that exercise the MCP route or managed-tool catalog get a fresh
// pair of registries with the built-in factories pre-registered. Tests that
// need additional tool factories (e.g. private overlays) construct their
// own pair separately.
function makeTestManagedToolRegistries(): {
  catalog: ManagedToolCatalog;
  factoryRegistry: ManagedToolFactoryRegistry;
} {
  const catalog = new ManagedToolCatalog();
  const factoryRegistry = new ManagedToolFactoryRegistry();
  registerBuiltinManagedTools(catalog, factoryRegistry);
  return { catalog, factoryRegistry };
}
import { registerMessageRoutes, type MessageRouteStores } from "../routes/messages.js";
import { registerModelRoutes, type ModelRouteStores } from "../routes/models.js";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";

type SessionRecord = {
  sessionId: string;
  userId: string;
  sessionName: string;
  status: "active" | "deleted";
  purpose?: string;
  createdAt: string;
  updatedAt: string;
};

type MessageRecord = {
  id: number;
  messageId: string;
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  status: "pending" | "streaming" | "completed" | "error";
  content: string;
  reasoningContent: string;
  planContent: string;
  tokenUsage: null;
  modelName: string | null;
  costUsd: number | null;
  feedbackRating: null;
  detail: Record<string, unknown>;
  toolResults: ToolResultRecord[];
  createdAt: string;
  updatedAt: string;
};

type ToolResultRecord = {
  id: number;
  toolResultId: string;
  messageId: string;
  sessionId: string;
  userId: string;
  kind: "command" | "mcp";
  title: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

type ToolContextRecord = {
  toolContextId: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  runtimePolicyId: string;
  messageId: string | null;
  credentialEnvelope: Record<string, unknown>;
  metadata: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
};

class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async list(
    _tenantId: string,
    userId: string,
    options: { purposes?: string[] | "all" } = {}
  ): Promise<SessionRecord[]> {
    const purposes = options.purposes;
    const includeAll = purposes === "all";
    const purposeFilter = includeAll
      ? null
      : Array.isArray(purposes) && purposes.length > 0
        ? new Set(purposes)
        : new Set(["normal"]);
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.status === "active")
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

  async getOwned(_tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session && session.userId === userId ? session : null;
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

  async remove(_tenantId: string, sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status !== "active") {
      return false;
    }
    this.sessions.set(sessionId, { ...session, status: "deleted", updatedAt: new Date().toISOString() });
    return true;
  }
}

class InMemoryMessageStore {
  private readonly messages: MessageRecord[] = [];
  private readonly toolResults = new Map<string, ToolResultRecord>();
  private nextId = 1;
  private nextToolId = 1;

  async listBySession(_tenantId: string, sessionId: string, userId: string): Promise<MessageRecord[]> {
    return this.messages
      .filter((message) => message.sessionId === sessionId && message.userId === userId)
      .map((message) => ({
        ...message,
        toolResults: [...this.toolResults.values()].filter(
          (toolResult) => toolResult.messageId === message.messageId
        )
      }));
  }

  async getOwned(_tenantId: string, messageId: string, userId: string): Promise<MessageRecord | null> {
    return this.messages.find((message) => message.messageId === messageId && message.userId === userId) ?? null;
  }

  async create(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    role: "user" | "assistant" | "system";
    status: "pending" | "streaming" | "completed" | "error";
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

  async updateTokenUsage() {
    // no-op in tests
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

  async appendToolResultOutput(_tenantId: string, toolResultId: string, userId: string, delta: string): Promise<ToolResultRecord | null> {
    const toolResult = this.toolResults.get(toolResultId);
    if (!toolResult || toolResult.userId !== userId) {
      return null;
    }
    toolResult.output += delta;
    toolResult.updatedAt = new Date().toISOString();
    return toolResult;
  }
}

class FakeRuntimeManager {
  readonly busySessions = new Set<string>();
  readonly abortedSessions: Array<{ sessionId: string; userId: string }> = [];
  readonly resolvedApprovals: Array<{ approvalId: string; tenantId: string; userId: string; decision: string; rememberForTurn?: boolean }> = [];
  readonly runMessageInputs: Array<{
    sessionId: string;
    runtimeId: string;
    prompt: string;
    userInputs?: RuntimeUserInput[];
    runtimePolicyId: string;
    toolContextId: string | null;
    assistantMessageId?: string | null;
    effort?: string;
    model?: string;
  }> = [];
  private readonly eventScripts = new Map<string, RuntimeEvent[]>();

  queueEvents(sessionId: string, events: RuntimeEvent[]): void {
    this.eventScripts.set(sessionId, events);
  }
  hasActiveTurn(sessionId: string): boolean { return this.busySessions.has(sessionId); }
  hasSession(_sessionId: string): boolean { return false; }
  async createSession(input: { sessionId: string; userId: string }) {
    return { sessionId: input.sessionId, runtimeId: `runtime-${input.sessionId}`, runtimePolicy: phase4RuntimePolicy };
  }
  async getRuntimePolicyId(_tenantId: string): Promise<string> { return "tenant-settings:test-tenant"; }
  async *runMessage(session: { sessionId: string; runtimeId: string }, input: {
    prompt: string; userInputs?: RuntimeUserInput[]; runtimePolicyId: string; toolContextId: string | null; assistantMessageId?: string | null; effort?: string; model?: string; onBeforeTurn?: () => Promise<void>;
  }) {
    if (input.onBeforeTurn) await input.onBeforeTurn();
    this.runMessageInputs.push({ sessionId: session.sessionId, runtimeId: session.runtimeId, ...input });
    for (const event of this.eventScripts.get(session.sessionId) ?? []) yield event;
  }
  async abortSession(input: { tenantId: string; sessionId: string; userId: string }) { this.abortedSessions.push(input); }
  async resolveApproval(input: { approvalId: string; tenantId: string; userId: string; decision: "approve" | "reject"; rememberForTurn?: boolean }) {
    this.resolvedApprovals.push(input);
    return "resolved" as const;
  }
  async readRuntimeFile(_sessionId: string, _filePath: string): Promise<Uint8Array> { return new Uint8Array(0); }
  async writeRuntimeFile(_sessionId: string, filePath: string, _data: Uint8Array | ArrayBuffer | string): Promise<string> { return filePath; }
  getHealthSnapshot() { return { activeRuntimeCount: 0, activeTurnCount: 0, runtimes: [] }; }
}

class InMemoryToolContextStore {
  private readonly contexts = new Map<string, ToolContextRecord>();
  readonly createdContexts: ToolContextRecord[] = [];
  private nextId = 1;
  async create(input: {
    tenantId: string; sessionId: string; userId: string; runtimeId: string; runtimePolicyId: string; messageId: string | null; credentialEnvelope?: Record<string, unknown>; metadata?: Record<string, unknown>; ttlMs: number;
  }): Promise<ToolContextRecord> {
    const now = new Date();
    const context: ToolContextRecord = {
      toolContextId: `ctx-test-${this.nextId++}`,
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
    let latest: ToolContextRecord | null = null;
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
}

class InMemoryArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly downloadTokens = new Map<string, ArtifactDownloadTokenRecord>();
  private nextId = 1;
  constructor(private readonly sessions: InMemorySessionStore) {}
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
  async listBySession(_tenantId: string, sessionId: string, userId: string) {
    return [...this.artifacts.values()].filter((artifact) => artifact.sessionId === sessionId && artifact.userId === userId && artifact.status !== "deleted");
  }
  async getOwned(_tenantId: string, artifactId: string, userId: string) { const artifact = this.artifacts.get(artifactId); return artifact && artifact.userId === userId ? artifact : null; }
  async get(_tenantId: string, artifactId: string) { return this.artifacts.get(artifactId) ?? null; }
  async findLatestReadableDerived(sourceArtifactId: string, userId: string) {
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
  async listPendingProcessingUploads(_tenantId: string) {
    return [...this.artifacts.values()].filter((artifact) => artifact.artifactType === "upload" && artifact.mimeType === "application/pdf" && (artifact.status === "pending" || artifact.status === "processing"));
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
  cleanedImageSets = 0;
  async extractArtifactText(artifact: ArtifactRecord): Promise<string | null> { return artifact.mimeType !== "application/pdf" ? null : "Extracted PDF text for testing."; }
  async renderArtifactImages(artifact: ArtifactRecord) {
    if (artifact.mimeType !== "application/pdf") return { paths: [], cleanup: async () => {} };
    return { paths: ["/tmp/document-2-page-1.png", "/tmp/document-2-page-2.png"], cleanup: async () => { this.cleanedImageSets += 1; } };
  }
}

export function parseSseEvents(payload: string): Array<{ event: string; data: Record<string, unknown> }> {
  return payload.trim().split("\n\n").filter(Boolean).map((chunk) => {
    const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
    if (!eventLine) throw new Error(`Missing SSE event line in chunk: ${chunk}`);
    if (!dataLine) throw new Error(`Missing SSE data line in chunk: ${chunk}`);
    return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown> };
  });
}

type TestAppPiiOptions = {
  piiProtection?: {
    evaluateText: (input: { tenantId: string; text: string; subject: unknown }) => Promise<unknown>;
    getActiveSettings?: (tenantId: string) => Promise<unknown>;
  };
  piiScanRuns?: {
    create: (input: unknown) => Promise<{ scanRunId: string }>;
    update?: (tenantId: string, scanRunId: string, patch: unknown) => Promise<unknown>;
  };
};

export async function createTestApp(
  configOverrides: Partial<AppConfig> & {
    proxyUpstreamUrl?: string;
    pii?: TestAppPiiOptions;
    tenantRuntimeProvider?: "codex" | "claude-code";
    enabledRuntimeProviders?: Array<"codex" | "claude-code">;
    showEffortSelector?: boolean;
    // Override the Policy Center gate at the MCP route. Defaults to a no-rules
    // stub (every action allows). Pass a real PolicyService (+ optional approval
    // router) to exercise transform / require_approval through the gateway.
    policyService?: unknown;
    requestPolicyApproval?: (input: {
      tenantId: string;
      sessionId: string;
      userId: string;
      runtimeId: string | null;
      toolName: string;
      serverId: string | null;
      severity: "read_only" | "file_change" | "command_execution";
      explanation: string;
    }) => Promise<"approve" | "reject" | "expired" | null>;
  } = {}
) {
  const {
    proxyUpstreamUrl,
    pii,
    tenantRuntimeProvider,
    enabledRuntimeProviders,
    showEffortSelector,
    policyService: policyServiceOverride,
    requestPolicyApproval: requestPolicyApprovalOverride,
    ...appConfigOverrides
  } = configOverrides;
  const db = new FakeDatabase();
  const sessions = new InMemorySessionStore();
  const messages = new InMemoryMessageStore();
  const runtimeManager = new FakeRuntimeManager();
  const toolContexts = new InMemoryToolContextStore();
  const approvals = new InMemoryApprovalStore();
  const artifacts = new InMemoryArtifactStore(sessions);
  const auditEvents = new InMemoryAuditEventStore();
  const artifactProcessor = new NoopArtifactProcessor();
  const app = Fastify();
  const artifactStorageRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-core-artifact-tests-"));
  const artifactStorage = new LocalArtifactStorage(artifactStorageRoot);
  const config = createTestConfig({ ARTIFACT_STORAGE_ROOT: artifactStorageRoot, ...appConfigOverrides });
  const limits = RequestLimits.fromAppConfig(config);
  app.decorate("config", config);
  app.decorate("db", db as unknown as Pool);
  await app.register(cors, { origin: config.API_ORIGIN, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "X-User-Id", "X-Tenant-Id"] });
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
  await registerHealthRoutes(app, { runtimeManager: runtimeManager as unknown as HealthRouteStores["runtimeManager"] });
  await registerModelRoutes(app, {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        const runtimeProvider = tenantRuntimeProvider ?? "codex";
        return {
          tenantId: "test-tenant",
          runtimeProvider,
          enabledRuntimeProviders: enabledRuntimeProviders ?? [runtimeProvider],
          showEffortSelector: showEffortSelector ?? false,
          approvalPolicy: "on-request" as const,
          approvalReviewer: "user" as const,
          allowCommandExecution: false,
          allowUserTokenForwarding: true,
          autoApproveReadOnlyTools: true,
          developerInstructions: null,
          enabledToolIds: [
            "managed-session-context",
            "session_context",
            "list_artifacts",
            "read_text_artifact",
            "write_artifact"
          ],
          enabledMcpServerIds: ["managed-session-context"],
          version: 1,
          configHash: "test-hash",
          updatedAt: new Date().toISOString()
        };
      }
    },
    runtimeAdapters: {
      "claude-code": {}
    },
    hasAnthropicApiKey: async () => true,
    hasOpenaiApiKey: async () => true
  } as unknown as ModelRouteStores);
  await registerSessionRoutes(app, {
    sessions,
    messages,
    runtimeManager,
    limits
  } as unknown as SessionRouteStores);
  await registerArtifactRoutes(app, {
    sessions,
    messages,
    artifacts,
    auditEvents,
    storage: artifactStorage,
    processor: artifactProcessor,
    limits
  } as unknown as ArtifactRouteStores);
  const activeTurnMessageMap = new ActiveTurnMessageMap();
  await registerMessageRoutes(app, {
    sessions,
    artifacts,
    artifactProcessor,
    storage: artifactStorage,
    limits,
    messages,
    toolContexts,
    runtimeManager,
    activeTurnMessageMap,
    ...(pii?.piiProtection ? { piiProtection: pii.piiProtection as never } : {}),
    ...(pii?.piiScanRuns ? { piiScanRuns: pii.piiScanRuns as never } : {})
  } as unknown as MessageRouteStores);
  await registerApprovalRoutes(app, {
    approvals,
    runtimeAdapters: { codex: runtimeManager }
  } as unknown as ApprovalRouteStores);
  const { factoryRegistry: managedToolFactoryRegistry, catalog: managedToolCatalog } =
    makeTestManagedToolRegistries();
  await registerMcpRoutes(app, {
    dynamicConfig: {
      async getMcpServer(_tenantId: string, serverId: string) {
        if (serverId === "managed-session-context") {
          return { id: "managed-session-context", description: "Managed session context", mode: "managed" as const, routePath: "/mcp/managed-session-context", upstreamUrl: null, transportKind: "http" as const, headersAllowlist: [], version: 1, hash: "hash-managed-session-context" };
        }
        return { id: serverId, description: "Test proxy", mode: "proxy" as const, routePath: `/mcp/${serverId}`, upstreamUrl: proxyUpstreamUrl ?? "https://example.com/mcp", transportKind: "http" as const, headersAllowlist: ["X-Framework-User-Id", "X-Framework-Session-Id", "X-Framework-Runtime-Id"], version: 1, hash: "hash-test-proxy" };
      }
    },
    sessions,
    messages,
    artifacts,
    storage: artifactStorage,
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
    // No active turn in these route tests by default → no adapter hosts
    // approvals, so the gateway degrades enforce-mode require_approval to a deny
    // (returns null). Tests can override to simulate a human decision.
    requestPolicyApproval: requestPolicyApprovalOverride ?? (async () => null),
    runtimeTokenSecret: "test-runtime-token-secret"
  } as unknown as McpRouteStores);
  app.addHook("onClose", async () => { await rm(artifactStorageRoot, { recursive: true, force: true }); });
  await app.ready();
  return { app, db, sessions, messages, runtimeManager, toolContexts, approvals, artifacts, auditEvents, artifactProcessor, limits };
}

export async function createTestToolContext(
  toolContexts: InMemoryToolContextStore,
  overrides: Partial<{ sessionId: string; userId: string; runtimeId: string; runtimePolicyId: string; messageId: string | null; credentialEnvelope: Record<string, unknown>; metadata: Record<string, unknown>; ttlMs: number; }> = {}
) {
  return toolContexts.create({
    tenantId: "test-tenant",
    sessionId: overrides.sessionId ?? "session-1",
    userId: overrides.userId ?? "test-user",
    runtimeId: overrides.runtimeId ?? "runtime-session-1",
    runtimePolicyId: overrides.runtimePolicyId ?? "tenant-settings:test-tenant",
    messageId: overrides.messageId ?? null,
    credentialEnvelope: overrides.credentialEnvelope,
    metadata: { runtimePolicy: phase4RuntimePolicy, ...(overrides.metadata ?? {}) },
    ttlMs: overrides.ttlMs ?? 60_000
  });
}
