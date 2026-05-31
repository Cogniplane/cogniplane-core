import type { FastifyBaseLogger } from "fastify";

import type { Pool } from "../lib/db.js";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import { ApprovalStore } from "./auth/approval-store.js";
import { ActivationTracker } from "./activation-tracker.js";
import { AuditEventStore } from "./audit-event-store.js";
import { PlatformEventStore } from "./platform-event-store.js";
import { TenantSettingsStore } from "./tenant-settings-store.js";
import { GithubConnectionStore } from "./integrations/github/github-connection-store.js";
import { IntegrationStateStore } from "./integrations/integration-state-store.js";
import { NotionConnectionStore } from "./integrations/notion/notion-connection-store.js";
import { MessageStore } from "./message-store.js";
import { McpServerStore } from "./mcp-server-store.js";
import { PiiAnalyticsStore } from "./pii/pii-analytics-store.js";
import { PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "./pii/pii-scan-run-store.js";
import { ActiveTurnsRegistry } from "./active-turns-registry.js";
import { RuntimeSessionStore } from "./runtime/runtime-session-store.js";
import { SessionRuntimeOverrideStore } from "./session-runtime-override-store.js";
import { SessionStore } from "./session-store.js";
import { SkillConfigStore } from "./skills/skill-config-store.js";
import { SkillRevisionStore } from "./skills/skill-revision-store.js";
import { ToolEventStore } from "./tool-event-store.js";
import { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { TenantMemberStore } from "./tenant-member-store.js";
import { UserSettingsStore } from "./user-settings-store.js";

export function buildStores(db: Pool, schedulerDb: Pool, privilegedDb: Pool, logger: FastifyBaseLogger) {
  const sessions = new SessionStore(db);
  const messages = new MessageStore(db);
  const activeTurns = new ActiveTurnsRegistry();
  const artifacts = new ArtifactStore(db, privilegedDb);
  const piiScanRuns = new PiiScanRunStore(db);
  const piiScanJobs = new PiiScanJobStore(db, schedulerDb);
  const piiAnalytics = new PiiAnalyticsStore(db);
  const runtimeSessions = new RuntimeSessionStore(db);
  const skills = new SkillConfigStore(db);
  const skillRevisions = new SkillRevisionStore(db, skills);
  const mcpServers = new McpServerStore(db);
  const tenantSettings = new TenantSettingsStore(db);
  const sessionRuntimeOverrides = new SessionRuntimeOverrideStore(db);
  const userSettings = new UserSettingsStore(db, schedulerDb);
  const tenantMembers = new TenantMemberStore(db);
  const githubConnections = new GithubConnectionStore(db);
  const notionConnections = new NotionConnectionStore(db);
  const approvals = new ApprovalStore(db);
  const auditEvents = new AuditEventStore(db);
  const platformEvents = new PlatformEventStore(db);
  const activationTracker = new ActivationTracker(db, logger);
  const toolEvents = new ToolEventStore(db);
  const toolContexts = new ToolExecutionContextStore(db);
  const integrationStates = new IntegrationStateStore(db);

  return {
    sessions,
    messages,
    activeTurns,
    artifacts,
    piiScanRuns,
    piiScanJobs,
    piiAnalytics,
    runtimeSessions,
    skills,
    skillRevisions,
    mcpServers,
    tenantSettings,
    sessionRuntimeOverrides,
    userSettings,
    tenantMembers,
    githubConnections,
    notionConnections,
    approvals,
    auditEvents,
    platformEvents,
    activationTracker,
    toolEvents,
    toolContexts,
    integrationStates
  };
}

export type Stores = ReturnType<typeof buildStores>;
