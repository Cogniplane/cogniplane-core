import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import { AsyncQueue } from "../../lib/async-queue.js";
import type { RuntimeApprovalKind, RuntimeEvent, RuntimeReasoningEffort } from "../../runtime-contracts.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";

import type { ResolvedRuntimePolicy, RuntimeConfigBundle, RuntimeProvider } from "../admin-config-records.js";
import type { CodexRuntimeProcess } from "./codex-runtime-process.js";
import type { PendingApprovalRecord } from "./runtime-approval-coordinator.js";
import type { WorkspaceArtifacts } from "./runtime-workspace.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";

export type RuntimeProcessHandle = Pick<
  CodexRuntimeProcess,
  | "port"
  | "pid"
  | "socketReadyState"
  | "isAlive"
  | "sendRequest"
  | "sendNotification"
  | "closeSocket"
  | "terminate"
  | "sendResponse"
  | "sendError"
  | "rejectPendingRequests"
  | "readFile"
  | "writeFile"
  | "onNotification"
  | "onRequest"
  | "onClose"
  | "onExit"
>;

export type RuntimeWorkspaceFactory = (
  config: AppConfig,
  input: {
    sessionId: string;
    userId: string;
    tenantId: string;
    runtimeId: string;
    runtimeConfig: RuntimeConfigBundle;
    skillBundleStorage: SkillBundleStorage;
    managedToolCatalog: ManagedToolCatalog;
  }
) => Promise<WorkspaceArtifacts>;

export type RuntimeProcessFactory = (input: {
  binaryPath: string;
  cwd: string;
  localWorkspacePath?: string;
  logger: FastifyBaseLogger;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  runtimeId: string;
  sessionId: string;
  env?: Record<string, string>;
}) => Promise<RuntimeProcessHandle>;

export type TurnTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type ActiveTurnState = {
  queue: AsyncQueue<RuntimeEvent>;
  responseId: string | null;
  outputItemDone: boolean;
  runtimePolicyId: string;
  toolContextId: string | null;
  assistantMessageId: string | null;
  model: string | null;
  effort: RuntimeReasoningEffort | null;
  autoApprovedKinds: Set<RuntimeApprovalKind>;
};

export type PendingApprovalMap = Map<string, PendingApprovalRecord>;
export type PendingApprovalTimerMap = Map<string, NodeJS.Timeout>;

export type RuntimeHealthStatus = "starting" | "healthy" | "terminating" | "terminated" | "error";

export type RuntimeShutdownReason =
  | "session_abort"
  | "idle_timeout"
  | "app_shutdown"
  | "config_drain"
  | "config_refresh"
  | "integration_credentials_changed"
  | "integration_state_changed"
  | "startup_failure"
  | "socket_closed"
  | "runtime_exit";

export type RuntimeState = {
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  provider: RuntimeProvider;
  workspacePath: string;
  manifestPath: string;
  manifest: RuntimeManifest;
  runtimePolicy: ResolvedRuntimePolicy;
  process: RuntimeProcessHandle;
  threadId: string;
  claudeSessionId: string | null;
  claudeResumeAt: string | null;
  activeTurn: ActiveTurnState | null;
  pendingApprovals: PendingApprovalMap;
  pendingApprovalTimers: PendingApprovalTimerMap;
  idleTimer: NodeJS.Timeout | null;
  healthStatus: RuntimeHealthStatus;
  startedAt: string;
  lastActiveAt: string;
  terminatedAt: string | null;
  lifecycleMetadata: Record<string, unknown>;
  shutdownReason: RuntimeShutdownReason | null;
  finalized: boolean;
  closed: boolean;
};
