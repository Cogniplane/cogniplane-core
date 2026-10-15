// Row-Level Security through the production write paths, for every tenant
// table.
//
// For each public table with a tenant_id column, the code that writes the table
// in production writes the row, on the pool production gives it. A store that
// writes with the wrong scope or with no scope fails here. Then the application
// role probes the row:
//
//   - the superuser pool finds exactly one row, keyed by tenant_id and the
//     table's own key, so a zero below cannot come from a missing row;
//   - the owner tenant's scope sees the row and the peer tenant's scope does not;
//   - the peer's UPDATE and DELETE leave the row in place;
//   - in the owner's scope, moving the row to the peer, or copying it into the
//     peer, fails WITH CHECK (SQLSTATE 42501). Append-only and immutable tables
//     are the documented exceptions for the move.
//
// Probes that could change data run in a transaction that always rolls back,
// so a broken policy cannot damage rows that later cases use.
//
// rls-isolation.integration.test.ts seeds rows on the superuser pool, so no
// store runs there. It keeps only the cases that this file does not probe.
//
// WRITE_PATHS must name exactly the tenant tables in the live catalog. A new
// tenant table fails this file until it gets a case: its production write path,
// or an exception with a stated reason.
//
// One table is a declared exception: user_microsoft_connections. Its only
// writer is in the private SharePoint overlay, which the public mirror does not
// contain, so this file seeds the row and tests the policy only. In the private
// repository, a companion test runs that writer on the application role against
// real Postgres. The private `pnpm test:integration` script runs it after this
// project, so a failure there fails the integration run.

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { ActivationTracker } from "../services/activation-tracker.js";
import type { StoredArtifact } from "../services/artifacts/artifact-storage.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { provisionTenantIdentity } from "../services/auth/workos-tenant-provisioning.js";
import { CustomModelStore } from "../services/custom-model-store.js";
import { GithubConnectionStore } from "../services/integrations/github/github-connection-store.js";
import { IntegrationStateStore } from "../services/integrations/integration-state-store.js";
import { NotionConnectionStore } from "../services/integrations/notion/notion-connection-store.js";
import { JiraConnectionStore } from "../services/integrations/pipedream/jira-connection-store.js";
import { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { McpAppCspStore } from "../services/mcp/mcp-app-csp-store.js";
import { McpConnectionTestService } from "../services/mcp/mcp-connection-test-service.js";
import { MemoryStore } from "../services/memory-store.js";
import { MessageStore } from "../services/message-store.js";
import { ModelSpendingStore } from "../services/model-spending-store.js";
import { PersonalCapabilityStore } from "../services/personal-capability-store.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { ProjectFileStore } from "../services/project-file-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectStore } from "../services/project-store.js";
import { RuntimeSessionStore } from "../services/runtime/runtime-session-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { OrganizationSkillSubmissionStore } from "../services/skills/organization-skill-submission-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { ProjectSkillStore } from "../services/skills/project-skill-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { ToolEventStore } from "../services/tool-event-store.js";
import { UserSettingsStore } from "../services/user-settings-store.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";

import {
  adminDatabaseUrl,
  appPool,
  maintenancePool,
  runRoleName,
  superuserPool
} from "./support/database.js";

/** Column values that identify one row. tenant_id is added by the harness. */
type RowKey = Record<string, string | number>;

type WritePath = {
  /** The production code that writes the row. */
  path: string;
  /**
   * How the owner's own UPDATE of tenant_id behaves. Unset means the tenant
   * policy's WITH CHECK rejects it. "append-only": a restrictive policy hides
   * the row from every UPDATE. "immutable": a BEFORE UPDATE trigger raises
   * before any policy check runs.
   */
  ownerUpdate?: "append-only" | "immutable";
  /** Writes the row as the owner tenant and returns its key. */
  write: () => Promise<RowKey>;
} & (
  | { writer: "app" }
  /**
   * Not written through the application pool. `reason` says why, and the
   * cases still assert the same peer isolation for the row.
   */
  | { writer: "maintenance" | "seeded"; reason: string }
);

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCRYPTION_SECRET = "rls-write-paths-integration-encryption-secret";
const INSUFFICIENT_PRIVILEGE = "42501";
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

/** Memoizes one async fixture, so cases that share a parent row share one write. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

// ── Fixture graph ──────────────────────────────────────────────────────────
//
// Tenants and memberships come from the WorkOS sign-in path on the maintenance
// pool, as in production. Everything else is written by stores on the app pool.

type Member = { tenantId: string; userId: string };

async function signIn(organizationId: string): Promise<Member> {
  const identity = await provisionTenantIdentity(maintenancePool(), {
    organizationId,
    organizationName: `Organization ${organizationId}`,
    workosUserId: unique("workos-user"),
    email: `${randomUUID()}@example.test`,
    displayName: "Integration member",
    workosRoleSlug: null
  });
  return { tenantId: identity.tenantId, userId: identity.userId };
}

/** The first sign-in to an organization becomes its owner; later ones are members. */
const people = once(async () => {
  const organization = unique("org-owner");
  const owner = await signIn(organization);
  const member = await signIn(organization);
  const peer = await signIn(unique("org-peer"));
  return { owner, member, peer };
});

/**
 * Object storage stand-in for the paths that copy or delete bytes. Deletion
 * always fails, so the GC paths keep their rows for the probes instead of
 * removing them.
 */
const storage = once(async () => {
  const objects = new Map<string, Buffer>();
  return {
    backend: "local" as const,
    async put(input: { storageKey: string; stream: Readable }): Promise<StoredArtifact> {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) chunks.push(Buffer.from(chunk as Buffer));
      const bytes = Buffer.concat(chunks);
      objects.set(input.storageKey, bytes);
      return {
        storageBackend: "local",
        storageKey: input.storageKey,
        fileSizeBytes: bytes.length,
        checksumSha256: createHash("sha256").update(bytes).digest("hex")
      };
    },
    async openReadStream(storageKey: string) {
      const bytes = objects.get(storageKey);
      if (!bytes) throw new Error(`test storage has no object ${storageKey}`);
      return { stream: Readable.from([bytes]), fileSizeBytes: bytes.length };
    },
    async delete(): Promise<void> {
      throw new Error("test storage refuses deletes");
    }
  };
});

const session = once(async () => {
  const { owner } = await people();
  return (await new SessionStore(appPool()).create(owner.tenantId, owner.userId, "Write paths")).sessionId;
});

const runtimeId = once(async () => {
  const { owner } = await people();
  const sessionId = await session();
  const id = unique("runtime");
  const now = new Date().toISOString();
  await new RuntimeSessionStore(appPool()).upsert({
    tenantId: owner.tenantId,
    sessionId,
    userId: owner.userId,
    runtimeId: id,
    runtimeProvider: "deepagents",
    workspacePath: `/workspace/${sessionId}`,
    runtimeVersion: "deepagentsjs",
    runtimeSchemaVersion: "1",
    manifestPath: "",
    manifestMetadata: {
      manifestVersion: "1",
      manifestHash: "hash",
      configBundleHash: "hash",
      sessionId,
      userId: owner.userId,
      generatedAt: now,
      workspacePath: `/workspace/${sessionId}`,
      runtimePolicy: {
        id: "default",
        version: 1,
        hash: "hash",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        networkMode: "restricted",
        allowCommandExecution: false,
        autoApproveReadOnlyTools: true,
        webSearchMode: "disabled",
        enabledToolIds: []
      },
      skills: [],
      mcpServers: [],
      configSources: { runtimePolicy: { id: "default", version: 1, hash: "hash" }, skills: [], mcpServers: [] },
      config: { skillsPath: "", customSkillsEnabled: false, customMcpServersEnabled: false }
    },
    healthStatus: "healthy",
    lastActiveAt: now,
    startedAt: now,
    terminatedAt: null,
    lifecycleMetadata: { mode: "in-process" },
    status: "active"
  });
  return id;
});

const message = once(async () => {
  const { owner } = await people();
  const created = await new MessageStore(appPool()).create({
    tenantId: owner.tenantId,
    sessionId: await session(),
    userId: owner.userId,
    role: "user",
    status: "completed",
    content: "Summarize the quarter."
  });
  return created.messageId;
});

const project = once(async () => {
  const { owner } = await people();
  return new ProjectStore(appPool()).create(owner.tenantId, owner.userId, unique("Write paths"));
});

const projectActor = once(async () => {
  const { owner } = await people();
  return { tenantId: owner.tenantId, userId: owner.userId, projectId: (await project()).projectId };
});

/** A ready artifact in a project session, written the way the write_artifact tool writes it. */
async function generateArtifact(sessionId: string) {
  const { owner } = await people();
  const stored = await (await storage()).put({
    storageKey: unique("artifact-object"),
    stream: Readable.from([Buffer.from(`Notes ${randomUUID()}`)])
  });
  return new ArtifactStore(appPool()).createGenerated({
    tenantId: owner.tenantId,
    artifactType: "generated",
    sessionId,
    userId: owner.userId,
    artifactName: "Notes.txt",
    mimeType: "text/plain",
    ...stored,
    status: "ready",
    createdByType: "tool",
    createdByRef: null
  });
}

const projectSession = once(async () => {
  const { owner } = await people();
  const { projectId } = await project();
  const sessionId = await new ProjectStore(appPool()).createSession(owner.tenantId, owner.userId, projectId, "Draft");
  if (!sessionId) throw new Error("ProjectStore.createSession returned no session");
  return sessionId;
});

const artifact = once(async () => generateArtifact(await projectSession()));

async function copyIntoProject(artifactId: string) {
  return new ProjectFileStore(appPool(), createSilentLogger()).createFromArtifact(
    await projectActor(),
    { artifactId, kind: "published", name: `${randomUUID()}.txt`, folderId: null, targetFileId: null, baseVersionId: null },
    await storage(),
    10_000
  );
}

const projectFile = once(async () => copyIntoProject((await artifact()).artifactId));

const modelSpending = () =>
  new ModelSpendingStore(appPool(), { monthlyLimitUsd: 100, turnReservationUsd: 1 });

const reservation = once(async () => {
  const { owner } = await people();
  const reserved = await modelSpending().reserve({
    tenantId: owner.tenantId,
    reservationId: randomUUID(),
    sessionId: await session(),
    userId: owner.userId,
    turnContext: "interactive",
    modelName: "gpt-6-sol"
  });
  if (!reserved) throw new Error("ModelSpendingStore.reserve returned no reservation");
  return reserved;
});

const scheduledJob = once(async () => {
  const { owner } = await people();
  const created = await new UserSettingsStore(appPool(), maintenancePool()).createScheduledJob({
    tenantId: owner.tenantId,
    jobId: randomUUID(),
    userId: owner.userId,
    jobName: "Weekly digest",
    description: null,
    cronExpression: "0 9 * * 1",
    timeZone: "UTC",
    targetType: "prompt",
    targetRef: null,
    input: { prompt: "Write the weekly digest." },
    settingsSnapshot: {},
    enabled: true,
    // Not due during the run, so scheduler sweeps in other files leave it alone.
    nextRunAt: FAR_FUTURE().toISOString()
  }, { maxActive: 0 });
  if (created.status !== "created") throw new Error("createScheduledJob did not create the job");
  return created.job.jobId;
});

const piiScanRun = once(async () => {
  const { owner } = await people();
  const run = await new PiiScanRunStore(appPool()).create({
    tenantId: owner.tenantId,
    subjectType: "message",
    subjectId: await message(),
    sourceSessionId: await session(),
    sourceUserId: owner.userId,
    mode: "detect"
  });
  return run.scanRunId;
});

const managedServer = once(async () => {
  const { owner } = await people();
  const serverId = unique("managed");
  return new McpServerStore(appPool(), ENCRYPTION_SECRET).createMcpServer(owner.tenantId, {
    serverId,
    serverName: "Local tools",
    description: null,
    transportKind: "http",
    mode: "managed",
    routePath: `/mcp/${serverId}`,
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthSecret: null,
    enabled: true,
    createdBy: owner.userId
  });
});

/** A published proxy server that takes a personal credential from each member. */
const personalServer = once(async () => {
  const { owner } = await people();
  const servers = new McpServerStore(appPool(), ENCRYPTION_SECRET);
  const serverId = unique("personal");
  await servers.createMcpServer(owner.tenantId, {
    serverId,
    serverName: "Vendor",
    description: null,
    transportKind: "http",
    mode: "proxy",
    routePath: `/mcp/${serverId}`,
    upstreamUrl: "https://vendor.example/mcp",
    upstreamAuthType: "header",
    upstreamAuthName: "X-Api-Key",
    upstreamAuthSecret: null,
    credentialScope: "personal",
    enabled: true,
    createdBy: owner.userId
  });
  await servers.setMcpServerPublished(owner.tenantId, serverId, true);
  await new TenantSettingsStore(appPool()).upsert(owner.tenantId, { enabledMcpServerIds: [serverId] });
  const server = await servers.getAdminMcpServer(owner.tenantId, serverId);
  if (!server) throw new Error("personal MCP server was not saved");
  return server;
});

const personalSkill = once(async () => {
  const { owner } = await people();
  return new PersonalSkillStore(appPool()).create(owner.tenantId, owner.userId, {
    kind: "inline",
    name: "meeting-notes",
    description: "Write meeting notes",
    instructions: "List decisions, then owners, then dates."
  });
});

const submission = once(async () => {
  const { owner } = await people();
  const skill = await personalSkill();
  return new OrganizationSkillSubmissionStore(appPool()).create(owner.tenantId, owner.userId, skill.id, 1, "", null);
});

/** The owner reviews and accepts the submission into a new organization skill. */
const acceptedSkillId = once(async () => {
  const { owner } = await people();
  const skillId = `team-notes-${randomUUID().slice(0, 8)}`;
  await new OrganizationSkillSubmissionStore(appPool()).decide(owner.tenantId, owner.userId, await submission(), {
    version: 1,
    action: "accept",
    reason: null,
    organizationSkillId: skillId,
    organizationSkillName: `Team notes ${skillId}`,
    expectedOrganizationVersion: null
  });
  return skillId;
});

const jira = () => new JiraConnectionStore(appPool());
const JIRA_BINDING = { projectId: "proj_rls", environment: "development" as const };

async function connectJira(user: Member) {
  const identity = await jira().bindIdentity(user.tenantId, user.userId, JIRA_BINDING, (n) => `cp1_rls_${n}`, true);
  if (!identity) throw new Error("JiraConnectionStore.bindIdentity returned no identity");
  await jira().upsert(
    {
      tenantId: user.tenantId,
      userId: user.userId,
      externalUserId: identity.externalUserId,
      accountId: "apn_rls",
      accountName: "me@example.test",
      cloudId: "11111111-2222-4333-8444-555555555555",
      siteName: "Acme",
      siteUrl: "https://acme.atlassian.net"
    },
    identity
  );
}

const ownerJira = once(async () => connectJira((await people()).owner));

/** Session Trash expiry, prepared up to the point where the cleanup job runs. */
const expiredSession = once(async () => {
  const { owner } = await people();
  const sessions = new SessionStore(appPool());
  const { sessionId } = await sessions.create(owner.tenantId, owner.userId, "Expiring");
  const { storageKey } = await generateArtifact(sessionId);
  if (!(await sessions.remove(owner.tenantId, sessionId, owner.userId))) throw new Error("session was not trashed");
  // Move deleted_at past the retention window instead of waiting for it.
  await superuserPool().query(
    "UPDATE sessions SET deleted_at = NOW() - ($3 * INTERVAL '1 day') WHERE tenant_id = $1 AND session_id = $2",
    [owner.tenantId, sessionId, sessions.getRetentionDays() + 1]
  );
  return { sessionId, storageKey };
});

const sessionCleanup = once(async () => {
  const expired = await expiredSession();
  // Large batch: rows that other files left in Trash must not crowd this one out.
  await new SessionStore(appPool(), maintenancePool()).cleanupExpired(await storage(), { batchSize: 10_000 });
  return expired;
});

/** A trashed project file past its 30-day retention, before the cleanup job runs. */
const expiredProjectFile = once(async () => {
  const actor = await projectActor();
  const file = await copyIntoProject((await generateArtifact(await projectSession())).artifactId);
  await new ProjectFileStore(appPool(), createSilentLogger()).trash(actor, file.fileId);
  await superuserPool().query(
    "UPDATE project_files SET trashed_at = NOW() - INTERVAL '31 days' WHERE tenant_id = $1 AND project_id = $2 AND file_id = $3",
    [actor.tenantId, actor.projectId, file.fileId]
  );
  // The API hides storage keys; read the one the GC row will carry.
  const { rows } = await superuserPool().query<{ storage_key: string }>(
    "SELECT storage_key FROM project_file_versions WHERE tenant_id = $1 AND project_id = $2 AND version_id = $3",
    [actor.tenantId, actor.projectId, file.version.versionId]
  );
  return { fileId: file.fileId, storageKey: rows[0]!.storage_key };
});

const projectFileCleanup = once(async () => {
  const expired = await expiredProjectFile();
  await new ProjectFileStore(appPool(), createSilentLogger(), maintenancePool()).cleanupExpired(await storage(), 10_000);
  return expired;
});

// ── The inventory ──────────────────────────────────────────────────────────
//
// One entry per tenant table, grouped by area. Several tables share one store
// call when production writes them in the same transaction.

const WRITE_PATHS: Record<string, WritePath> = {
  // Identity and membership: written at sign-in, before a tenant scope exists.
  tenants: {
    path: "provisionTenantIdentity (WorkOS callback)",
    writer: "maintenance",
    reason:
      "The auth callback creates the tenant before any tenant scope exists, so production runs it " +
      "on the BYPASSRLS maintenance pool (app.ts). The application pool is refused below.",
    write: async () => ({})
  },
  tenant_memberships: {
    path: "provisionTenantIdentity (WorkOS callback)",
    writer: "maintenance",
    reason: "Written in the same sign-in transaction as the tenant row.",
    write: async () => ({ user_id: (await people()).member.userId })
  },

  // Sessions and the runtime turn.
  sessions: {
    path: "SessionStore.create",
    writer: "app",
    write: async () => ({ session_id: await session() })
  },
  runtime_sessions: {
    path: "RuntimeSessionStore.upsert",
    writer: "app",
    write: async () => ({ runtime_id: await runtimeId() })
  },
  messages: {
    path: "MessageStore.create",
    writer: "app",
    write: async () => ({ message_id: await message() })
  },
  message_tool_results: {
    path: "MessageStore.upsertToolResult",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const toolResultId = unique("tool-result");
      await new MessageStore(appPool()).upsertToolResult({
        tenantId: owner.tenantId,
        toolResultId,
        messageId: await message(),
        sessionId: await session(),
        userId: owner.userId,
        kind: "command",
        title: "List files",
        status: "completed",
        command: "ls",
        cwd: "/workspace",
        server: null,
        toolName: null,
        input: "ls",
        output: "notes.txt",
        exitCode: 0,
        durationMs: 12,
        textOffset: 0
      });
      return { tool_result_id: toolResultId };
    }
  },
  tool_execution_contexts: {
    path: "ToolExecutionContextStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const context = await new ToolExecutionContextStore(appPool()).create({
        tenantId: owner.tenantId,
        sessionId: await session(),
        userId: owner.userId,
        runtimeId: await runtimeId(),
        runtimePolicyId: "default",
        messageId: await message(),
        ttlMs: 10 * 60 * 1000
      });
      return { tool_context_id: context.toolContextId };
    }
  },
  tool_events: {
    path: "ToolEventStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const toolCallId = unique("tool-call");
      await new ToolEventStore(appPool()).create({
        tenantId: owner.tenantId,
        sessionId: await session(),
        userId: owner.userId,
        messageId: await message(),
        runtimeId: await runtimeId(),
        toolCallId,
        kind: "command",
        title: "List files",
        phase: "completed",
        status: "completed",
        payload: { command: "ls" },
        durationMs: 12
      });
      return { tool_call_id: toolCallId };
    }
  },
  approvals: {
    path: "ApprovalStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const approvalId = unique("approval");
      await new ApprovalStore(appPool()).create({
        tenantId: owner.tenantId,
        approvalId,
        sessionId: await session(),
        userId: owner.userId,
        runtimeId: await runtimeId(),
        turnId: unique("turn"),
        itemId: unique("item"),
        requestMethod: "tools/call",
        requestId: unique("request"),
        kind: "command_execution",
        title: "Run a command",
        summary: "ls",
        status: "pending",
        decision: null,
        requestPayload: { command: "ls" },
        // Not expired during the run, so the stale-approval sweep leaves it alone.
        expiresAt: FAR_FUTURE().toISOString()
      });
      return { approval_id: approvalId };
    }
  },
  session_executions: {
    path: "SessionExecutionStore.acquire",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      // Its own session: an execution row makes ApprovalStore.create demand a
      // matching active runtime, which would couple the two cases.
      const { sessionId } = await new SessionStore(appPool()).create(owner.tenantId, owner.userId, "Turn");
      await new SessionExecutionStore(appPool()).acquire(
        { tenantId: owner.tenantId, sessionId, userId: owner.userId },
        10 * 60 * 1000
      );
      return { session_id: sessionId };
    }
  },
  agent_memories: {
    path: "MemoryStore.save",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const memory = await new MemoryStore(appPool()).save(owner.tenantId, owner.userId, {
        slug: `fact-${randomUUID()}`,
        content: "The quarter closes on a Friday.",
        provenance: {
          sourceSessionId: `session-${randomUUID()}`,
          approvedByUserId: owner.userId,
          approvalId: `approval-${randomUUID()}`,
          approvedAt: new Date().toISOString()
        }
      });
      return { memory_id: memory.memoryId };
    }
  },
  audit_events: {
    path: "AuditEventStore.create",
    writer: "app",
    ownerUpdate: "append-only",
    write: async () => {
      const { owner } = await people();
      // The table's key is a sequence; the user agent is the marker this case can find.
      const userAgent = unique("rls-write-paths");
      await new AuditEventStore(appPool()).create({
        tenantId: owner.tenantId,
        sessionId: await session(),
        userId: owner.userId,
        type: "artifact_downloaded",
        payload: { artifactId: (await artifact()).artifactId },
        userAgent
      });
      return { user_agent: userAgent };
    }
  },
  resource_activations: {
    path: "ActivationTracker.recordEvent",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      // The tracker swallows write errors by design, so collect them here.
      const warnings: unknown[] = [];
      const resourceId = unique("skill");
      await new ActivationTracker(appPool(), { warn: (...entry) => warnings.push(entry) }).recordEvent(
        { tenantId: owner.tenantId, sessionId: await session(), messageId: await message() },
        { resourceType: "skill", resourceId, eventType: "materialized" }
      );
      expect(warnings).toEqual([]);
      return { resource_id: resourceId };
    }
  },

  // Files.
  artifacts: {
    path: "ArtifactStore.createGenerated",
    writer: "app",
    write: async () => ({ artifact_id: (await artifact()).artifactId })
  },
  artifact_download_tokens: {
    path: "ArtifactStore.createDownloadToken",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const source = await artifact();
      const token = await new ArtifactStore(appPool()).createDownloadToken({
        tenantId: owner.tenantId,
        artifactId: source.artifactId,
        sessionId: source.sessionId,
        userId: owner.userId,
        storageBackend: source.storageBackend,
        storageKey: source.storageKey,
        fileName: source.artifactName,
        contentType: source.mimeType,
        ttlMs: 60_000
      });
      return { token: token.token };
    }
  },
  session_storage_gc: {
    path: "SessionStore.cleanupExpired (Trash retention job)",
    writer: "maintenance",
    reason:
      "The retention job selects expired sessions across every tenant, so production runs it on the " +
      "maintenance pool (scheduler worker). On the application pool it purges nothing; see below.",
    write: async () => {
      const { sessionId, storageKey } = await sessionCleanup();
      return { session_id: sessionId, storage_key: storageKey };
    }
  },
  session_runtime_gc: {
    path: "SessionStore.cleanupExpired (Trash retention job)",
    writer: "maintenance",
    reason: "Written in the same cross-tenant retention transaction as session_storage_gc.",
    write: async () => ({ session_id: (await sessionCleanup()).sessionId })
  },

  // Projects.
  projects: {
    path: "ProjectStore.create",
    writer: "app",
    write: async () => ({ project_id: (await project()).projectId })
  },
  project_memberships: {
    path: "ProjectMemberStore.setMember",
    writer: "app",
    write: async () => {
      const { member } = await people();
      const actor = await projectActor();
      await new ProjectMemberStore(appPool()).setMember(actor, member.userId, "editor");
      return { project_id: actor.projectId, user_id: member.userId };
    }
  },
  project_folders: {
    path: "ProjectFileStore.createFolder",
    writer: "app",
    write: async () => {
      const actor = await projectActor();
      const folder = await new ProjectFileStore(appPool(), createSilentLogger()).createFolder(actor, "Reports", null);
      return { project_id: actor.projectId, folder_id: folder.folderId };
    }
  },
  project_files: {
    path: "ProjectFileStore.createFromArtifact",
    writer: "app",
    write: async () => ({ project_id: (await project()).projectId, file_id: (await projectFile()).fileId })
  },
  project_file_versions: {
    path: "ProjectFileStore.createFromArtifact",
    writer: "app",
    ownerUpdate: "immutable",
    write: async () => {
      const file = await projectFile();
      return { project_id: (await project()).projectId, file_id: file.fileId, version_id: file.version.versionId };
    }
  },
  project_file_storage_gc: {
    path: "ProjectFileStore.cleanupExpired (retention job)",
    writer: "maintenance",
    reason:
      "The retention job selects expired files across every tenant, so production runs it on the " +
      "maintenance pool (scheduler worker). On the application pool it removes nothing; see below.",
    write: async () => ({
      project_id: (await project()).projectId,
      storage_key: (await projectFileCleanup()).storageKey
    })
  },
  project_skills: {
    path: "ProjectSkillStore.create",
    writer: "app",
    write: async () => {
      const actor = await projectActor();
      const skill = await new ProjectSkillStore(appPool()).create(actor.tenantId, actor.userId, actor.projectId, {
        kind: "inline",
        name: "release-notes",
        description: "Write release notes",
        instructions: "Group changes by area."
      });
      return { project_id: actor.projectId, skill_id: skill.id };
    }
  },
  project_skill_revisions: {
    path: "ProjectSkillStore.create",
    writer: "app",
    write: async () => {
      const actor = await projectActor();
      const skill = await new ProjectSkillStore(appPool()).create(actor.tenantId, actor.userId, actor.projectId, {
        kind: "inline",
        name: "status-report",
        description: "Write a status report",
        instructions: "Start with risks."
      });
      return { project_id: actor.projectId, skill_id: skill.id, revision: 1 };
    }
  },

  // Skills.
  personal_skills: {
    path: "PersonalSkillStore.create",
    writer: "app",
    write: async () => ({ user_id: (await people()).owner.userId, skill_id: (await personalSkill()).id })
  },
  personal_skill_revisions: {
    path: "PersonalSkillStore.create",
    writer: "app",
    write: async () => ({ user_id: (await people()).owner.userId, skill_id: (await personalSkill()).id, revision: 1 })
  },
  organization_skill_submissions: {
    path: "OrganizationSkillSubmissionStore.create",
    writer: "app",
    write: async () => ({ submission_id: await submission() })
  },
  organization_skill_submission_attempts: {
    path: "OrganizationSkillSubmissionStore.create",
    writer: "app",
    write: async () => ({ submission_id: await submission(), attempt: 1 })
  },
  organization_skill_author_updates: {
    path: "OrganizationSkillSubmissionStore.decide",
    writer: "app",
    ownerUpdate: "immutable",
    write: async () => {
      await acceptedSkillId();
      return { submission_id: await submission(), attempt: 1 };
    }
  },
  admin_skills: {
    path: "OrganizationSkillSubmissionStore.decide (accept)",
    writer: "app",
    write: async () => ({ skill_id: await acceptedSkillId() })
  },
  admin_skill_revisions: {
    path: "OrganizationSkillSubmissionStore.decide (accept)",
    writer: "app",
    write: async () => ({ skill_id: await acceptedSkillId(), revision_number: 1 })
  },
  personal_capability_defaults: {
    path: "PersonalCapabilityStore.save",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const selection = { skillIds: [], connectorIds: [] };
      const saved = await new PersonalCapabilityStore(appPool()).save(
        owner.tenantId,
        owner.userId,
        { selection, version: 0 },
        selection
      );
      if (!saved) throw new Error("PersonalCapabilityStore.save reported a conflict");
      return { user_id: owner.userId };
    }
  },

  // MCP servers.
  admin_mcp_servers: {
    path: "McpServerStore.createMcpServer",
    writer: "app",
    write: async () => ({ server_id: (await managedServer()).serverId })
  },
  admin_mcp_connection_tests: {
    path: "McpConnectionTestService.test",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const server = await managedServer();
      // A managed server is tested without any network call.
      await new McpConnectionTestService({
        db: appPool(),
        servers: new McpServerStore(appPool(), ENCRYPTION_SECRET),
        credentials: new MemberMcpCredentialStore(appPool(), ENCRYPTION_SECRET),
        timeoutMs: 1_000
      }).test(owner.tenantId, owner.userId, server.serverId, {
        expectedVersion: server.version,
        expectedConfigHash: server.configHash
      });
      return { server_id: server.serverId, scope_user_id: "" };
    }
  },
  admin_mcp_app_csp_approvals: {
    path: "McpAppCspStore.approve",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const server = await managedServer();
      const entry = { directive: "connectDomains" as const, source: "https://api.vendor.com" };
      await new McpAppCspStore(appPool()).approve(owner.tenantId, server.serverId, entry, owner.userId, () => ({
        tenantId: owner.tenantId, sessionId: null, userId: owner.userId,
        type: "admin.mcp_server.widget_domain_approved", payload: { serverId: server.serverId, ...entry }
      }));
      return { server_id: server.serverId, directive: entry.directive, source: entry.source };
    }
  },
  admin_mcp_app_csp_requests: {
    path: "McpAppCspStore.recordRequested",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const server = await managedServer();
      const entry = { directive: "resourceDomains" as const, source: "https://cdn.vendor.com" };
      await new McpAppCspStore(appPool()).recordRequested(owner.tenantId, server.serverId, [entry]);
      return { server_id: server.serverId, directive: entry.directive, source: entry.source };
    }
  },
  member_mcp_credentials: {
    path: "MemberMcpCredentialStore.save",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const server = await personalServer();
      await new MemberMcpCredentialStore(appPool(), ENCRYPTION_SECRET).save(owner.tenantId, owner.userId, server.serverId, {
        version: 0,
        serverVersion: server.version,
        secret: "personal-secret",
        accountLabel: null
      });
      return { user_id: owner.userId, server_id: server.serverId };
    }
  },

  // Organization settings and models.
  tenant_settings: {
    path: "TenantSettingsStore.upsert",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new TenantSettingsStore(appPool()).upsert(owner.tenantId, { showEffortSelector: true });
      return {};
    }
  },
  tenant_org_settings: {
    path: "TenantOrgSettingsStore.setMarketplaceUrl",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET).setMarketplaceUrl(
        owner.tenantId,
        "https://skills.example.test/manifest.json"
      );
      return {};
    }
  },
  tenant_custom_models: {
    path: "CustomModelStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const created = await new CustomModelStore(appPool()).create(owner.tenantId, {
        provider: "openrouter",
        vendorModelId: unique("vendor-model"),
        displayName: "Vendor model",
        description: "",
        contextWindow: 128_000,
        createdBy: owner.userId
      });
      if (!created) throw new Error("CustomModelStore.create reported a duplicate");
      return { model_id: created.modelId };
    }
  },
  tenant_integrations: {
    path: "IntegrationStateStore.upsert",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new IntegrationStateStore(appPool()).upsert(owner.tenantId, "github", {
        readsEnabled: true,
        updatedBy: owner.userId
      });
      return { integration_id: "github" };
    }
  },
  tenant_model_spending_policy: {
    path: "ModelSpendingStore.reserve",
    writer: "app",
    write: async () => {
      await reservation();
      return {};
    }
  },
  model_spending_reservations: {
    path: "ModelSpendingStore.reserve",
    writer: "app",
    write: async () => ({ reservation_id: (await reservation()).reservationId })
  },
  model_spending_calls: {
    path: "ModelSpendingStore.startCall",
    writer: "app",
    write: async () => {
      const reserved = await reservation();
      const callId = unique("call");
      await modelSpending().startCall(reserved, callId, "gpt-6-sol");
      return { reservation_id: reserved.reservationId, call_id: callId };
    }
  },

  // Policy Center.
  policy_rule: {
    path: "PolicyRuleStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const rule = await new PolicyRuleStore(appPool()).create(
        owner.tenantId,
        { name: "Review exports", effect: "require_approval", conditions: { toolNames: ["export_customers"] } },
        owner.userId
      );
      return { rule_id: rule.ruleId };
    }
  },
  policy_decision: {
    path: "PolicyDecisionStore.record",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const decision = await new PolicyDecisionStore(appPool()).record(owner.tenantId, {
        sessionId: await session(),
        userId: owner.userId,
        runtimeId: null,
        toolName: "export_customers",
        toolCategory: null,
        severity: null,
        serverId: null,
        matchedRuleId: null,
        outcome: "allow",
        enforced: false,
        explanation: null,
        actionSnapshot: { argumentKeys: ["format"] }
      });
      return { decision_id: decision.decisionId };
    }
  },

  // PII scanning.
  pii_scan_runs: {
    path: "PiiScanRunStore.create",
    writer: "app",
    write: async () => ({ scan_run_id: await piiScanRun() })
  },
  pii_scan_jobs: {
    path: "PiiScanJobStore.create",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const job = await new PiiScanJobStore(appPool(), maintenancePool()).create({
        tenantId: owner.tenantId,
        scanRunId: await piiScanRun(),
        subjectType: "message",
        subjectId: await message(),
        sourceSessionId: await session(),
        sourceUserId: owner.userId,
        mode: "detect",
        // Not due during the run, so claim sweeps in other files leave it alone.
        runAfter: FAR_FUTURE()
      });
      return { job_id: job.jobId };
    }
  },

  // Member settings and scheduled work.
  user_settings_sections: {
    path: "UserSettingsStore.upsertSection",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new UserSettingsStore(appPool(), maintenancePool()).upsertSection({
        tenantId: owner.tenantId,
        userId: owner.userId,
        sectionKey: "model",
        config: { defaultModel: "gpt-6-sol" }
      });
      return { user_id: owner.userId, section_key: "model" };
    }
  },
  scheduled_jobs: {
    path: "UserSettingsStore.createScheduledJob",
    writer: "app",
    write: async () => ({ job_id: await scheduledJob() })
  },
  scheduled_job_runs: {
    path: "UserSettingsStore.createJobRun",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      const runId = randomUUID();
      await new UserSettingsStore(appPool(), maintenancePool()).createJobRun({
        tenantId: owner.tenantId,
        runId,
        jobId: await scheduledJob(),
        userId: owner.userId,
        sessionId: null
      });
      return { run_id: runId };
    }
  },

  // Per-member integrations.
  user_github_connections: {
    path: "GithubConnectionStore.upsert",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new GithubConnectionStore(appPool()).upsert({
        tenantId: owner.tenantId,
        userId: owner.userId,
        githubUserId: unique("github-user"),
        githubLogin: "octo",
        githubName: null,
        githubEmail: null,
        githubAvatarUrl: null,
        tokenType: "bearer",
        grantedScopes: ["repo"],
        accessTokenEncrypted: "encrypted-access-token",
        accessTokenExpiresAt: null,
        refreshTokenEncrypted: null,
        refreshTokenExpiresAt: null,
        tokenLastRefreshedAt: null
      });
      return { user_id: owner.userId };
    }
  },
  user_notion_connections: {
    path: "NotionConnectionStore.upsert",
    writer: "app",
    write: async () => {
      const { owner } = await people();
      await new NotionConnectionStore(appPool()).upsert({
        tenantId: owner.tenantId,
        userId: owner.userId,
        notionUserId: unique("notion-user"),
        notionWorkspaceId: null,
        notionWorkspaceName: null,
        notionWorkspaceIcon: null,
        notionBotId: null,
        notionOwnerEmail: null,
        notionOwnerName: null,
        tokenType: "bearer",
        grantedScopes: [],
        accessTokenEncrypted: "encrypted-access-token",
        accessTokenExpiresAt: null,
        refreshTokenEncrypted: null,
        refreshTokenExpiresAt: null,
        tokenLastRefreshedAt: null
      });
      return { user_id: owner.userId };
    }
  },
  user_jira_identities: {
    path: "JiraConnectionStore.bindIdentity",
    writer: "app",
    write: async () => {
      await ownerJira();
      return { user_id: (await people()).owner.userId };
    }
  },
  user_jira_connections: {
    path: "JiraConnectionStore.upsert",
    writer: "app",
    write: async () => {
      await ownerJira();
      return { user_id: (await people()).owner.userId };
    }
  },
  user_jira_cleanups: {
    path: "JiraConnectionStore.retire",
    writer: "app",
    write: async () => {
      // The member, not the owner: retiring removes the owner's connection row
      // that the case above probes.
      const { member } = await people();
      await connectJira(member);
      const cleanup = await jira().retire(member.tenantId, member.userId, "user_disconnect", JIRA_BINDING);
      if (!cleanup) throw new Error("JiraConnectionStore.retire returned no cleanup");
      return { cleanup_id: cleanup.cleanupId };
    }
  },
  user_microsoft_connections: {
    path: "MicrosoftConnectionStore.upsert (private SharePoint overlay)",
    writer: "seeded",
    reason:
      "The only writer is in private/sharepoint-overlay-backend. This file ships in the public " +
      "mirror, which has no private/ tree, so it cannot import that store. overlay-contracts.test.ts " +
      "does not enforce this, because it skips test files. The superuser seeds the row with the " +
      "columns the overlay inserts, so this case tests the policy only, not the overlay's tenant " +
      "scope. The private companion " +
      "private/sharepoint-overlay-backend/src/services/microsoft-connection-store.integration.test.ts " +
      "runs the real upsert on the application role against real Postgres. The test below fails if " +
      "core backend code starts to write the table.",
    write: async () => {
      const { owner } = await people();
      await superuserPool().query(
        `INSERT INTO user_microsoft_connections
           (tenant_id, user_id, microsoft_user_id, granted_scopes, access_token_encrypted)
         VALUES ($1, $2, $3, '["Files.Read"]'::jsonb, 'encrypted-access-token')`,
        [owner.tenantId, owner.userId, unique("microsoft-user")]
      );
      return { user_id: owner.userId };
    }
  }
};

const CASES = Object.entries(WRITE_PATHS).map(([table, entry]) => ({ table, ...entry }));

/** Each table's row is written once, then shared by every probe. */
const written = new Map<string, Promise<RowKey>>();
function rowOf(table: string): Promise<RowKey> {
  let row = written.get(table);
  if (!row) {
    const entry = WRITE_PATHS[table];
    if (!entry) throw new Error(`No write path for ${table}`);
    row = (async () => ({ tenant_id: (await people()).owner.tenantId, ...(await entry.write()) }))();
    written.set(table, row);
  }
  return row;
}

// ── Probes ─────────────────────────────────────────────────────────────────

type Queryable = { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult> };

/** `column = $n AND ...` over the key. Columns come from WRITE_PATHS, never from input. */
function match(key: RowKey, firstParam = 1) {
  const columns = Object.keys(key);
  return {
    sql: columns.map((column, index) => `${column} = $${firstParam + index}`).join(" AND "),
    values: columns.map((column) => key[column]!)
  };
}

async function countRows(db: Queryable, table: string, key: RowKey): Promise<number> {
  const { sql, values } = match(key);
  const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${sql}`, values);
  return Number(rows[0]?.count);
}

/**
 * Runs `work` as the application role in `tenantId`'s scope, then rolls back
 * whatever happened. Same GUC as withTenantScope; only the ending differs.
 */
async function rolledBack<T>(tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool().connect();
  let rollbackError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch((error: Error) => {
      rollbackError = error;
    });
    client.release(rollbackError);
  }
}

const rlsRejection = {
  code: INSUFFICIENT_PRIVILEGE,
  message: expect.stringMatching(/row-level security/)
};

describe.skipIf(!adminDatabaseUrl())("RLS through production write paths", () => {
  afterAll(async () => {
    // The GC rows stay due for the retention jobs. Remove them so a later
    // file's cleanup run does not count them as its own work.
    const { owner } = await people();
    for (const table of ["session_storage_gc", "session_runtime_gc", "project_file_storage_gc"]) {
      await superuserPool().query(`DELETE FROM ${table} WHERE tenant_id = $1`, [owner.tenantId]);
    }
  });

  test("WRITE_PATHS names every tenant table in the live catalog, and no other table", async () => {
    // Same selection as the catalog test: ordinary tables in public with a
    // tenant_id column.
    const { rows } = await superuserPool().query<{ table_name: string }>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    const catalog = rows.map((row) => row.table_name);
    const inventory = Object.keys(WRITE_PATHS).sort();

    expect(
      catalog.filter((table) => !(table in WRITE_PATHS)),
      "A tenant table has no entry in WRITE_PATHS. Add a case that writes the row " +
        "through its production store, or an exception with a reason."
    ).toEqual([]);
    expect(
      inventory.filter((table) => !catalog.includes(table)),
      "WRITE_PATHS names a table that is gone or has no tenant_id column."
    ).toEqual([]);
  });

  test("a seeded exception still has no writer in the backend source", async () => {
    // The exception holds only while no backend code inserts into the table.
    // When a store appears, this fails and the case must call that store.
    const seeded = CASES.filter((entry) => entry.writer === "seeded").map((entry) => entry.table);
    const sources = (await readdir(SRC_DIR, { recursive: true }))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const writers: string[] = [];
    for (const file of sources) {
      const text = await readFile(path.join(SRC_DIR, file), "utf8");
      for (const table of seeded) {
        if (new RegExp(`INSERT INTO\\s+(public\\.)?${table}\\b`).test(text)) writers.push(`${table}: ${file}`);
      }
    }
    expect(seeded.length).toBeGreaterThan(0);
    expect(writers).toEqual([]);
  });

  // Before the per-table cases: those run the maintenance cleanup, which
  // removes the expired session and file these tests need.
  describe("lifecycle paths refuse the application pool", () => {
    test("WorkOS provisioning cannot create a tenant without the maintenance pool", async () => {
      const attempt = provisionTenantIdentity(appPool(), {
        organizationId: unique("org-app-pool"),
        organizationName: "Application pool",
        workosUserId: unique("workos-user"),
        email: `${randomUUID()}@example.test`,
        displayName: "Application pool",
        workosRoleSlug: null
      });
      await expect(attempt).rejects.toMatchObject(rlsRejection);
    });

    test("session Trash cleanup on the application pool purges nothing", async () => {
      const { owner } = await people();
      const { sessionId } = await expiredSession();
      // No tenant scope, so the cross-tenant candidate query sees no session.
      const result = await new SessionStore(appPool()).cleanupExpired(await storage(), { batchSize: 10_000 });
      expect(result).toEqual({ deletedSessions: 0, deletedObjects: 0, purgedRuntimes: 0 });
      expect(
        await countRows(superuserPool(), "sessions", { tenant_id: owner.tenantId, session_id: sessionId, status: "deleted" })
      ).toBe(1);
    });

    test("project file cleanup on the application pool removes nothing", async () => {
      const actor = await projectActor();
      const { fileId } = await expiredProjectFile();
      const result = await new ProjectFileStore(appPool(), createSilentLogger()).cleanupExpired(await storage(), 10_000);
      expect(result).toEqual({ deletedFiles: 0, deletedObjects: 0 });
      expect(
        await countRows(superuserPool(), "project_files", {
          tenant_id: actor.tenantId,
          project_id: actor.projectId,
          file_id: fileId
        })
      ).toBe(1);
    });
  });

  describe.each(CASES)("$table ← $path", ({ table, ownerUpdate }) => {
    let key: RowKey;
    let owner: Member;
    let peer: Member;

    // In each test, not in beforeAll: a writer that throws must fail these
    // tests, not mark them skipped. rowOf() writes the row only once.
    beforeEach(async () => {
      ({ owner, peer } = await people());
      key = await rowOf(table);
    });

    test("one stored row, visible to its tenant, hidden from the peer", async () => {
      // Present at all, and not ambiguous: the zero under the peer means nothing otherwise.
      expect(await countRows(superuserPool(), table, key), `${table} row was not written`).toBe(1);
      expect(await withTenantScope(appPool(), owner.tenantId, (client) => countRows(client, table, key))).toBe(1);
      expect(await withTenantScope(appPool(), peer.tenantId, (client) => countRows(client, table, key))).toBe(0);
    });

    test("the peer's UPDATE and DELETE do not reach the row", async () => {
      // No WHERE clause, on purpose. A WHERE that reads the table's columns
      // makes Postgres apply the SELECT policy as well, which would hide a
      // broken UPDATE or DELETE policy. Without one, only the command's own
      // policy picks the rows. The peer's own rows change too; the rollback
      // undoes that. Then, in the same transaction, the owner's scope looks
      // for the row.
      const afterPeer = (statement: string, values: unknown[] = []) =>
        rolledBack(peer.tenantId, async (client) => {
          await client.query(statement, values);
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [owner.tenantId]);
          return countRows(client, table, key);
        });

      expect(await afterPeer(`UPDATE ${table} SET tenant_id = $1`, [peer.tenantId]), "peer UPDATE").toBe(1);
      expect(await afterPeer(`DELETE FROM ${table}`), "peer DELETE").toBe(1);
    });

    test("WITH CHECK stops the owner moving or copying the row to the peer", async () => {
      const { sql, values } = match(key);
      const peerParam = values.length + 1;

      // No WHERE clause, for the same reason as the peer probe: a WHERE that
      // reads columns adds the SELECT policy's check on the new row, which
      // would hide a permissive UPDATE WITH CHECK. The owner's other rows in
      // this table move too; the rollback undoes that.
      const move = rolledBack(owner.tenantId, (client) =>
        client.query(`UPDATE ${table} SET tenant_id = $1`, [peer.tenantId])
      );
      if (ownerUpdate === "append-only") {
        // A restrictive USING (false) hides the row from every UPDATE.
        expect((await move).rowCount).toBe(0);
      } else if (ownerUpdate === "immutable") {
        // The BEFORE UPDATE trigger raises before the policy is evaluated.
        await expect(move).rejects.toThrow(/immutable/);
      } else {
        await expect(move).rejects.toMatchObject(rlsRejection);
      }

      // The stored row with only tenant_id changed. The alias must not match a
      // column name (admin_mcp_app_csp_* tables have a `source` column). Every other column is the
      // one the store wrote, so no NOT NULL or check constraint can fail
      // first, and RLS runs before unique and foreign key checks.
      const copy = rolledBack(owner.tenantId, (client) =>
        client.query(
          `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
           SELECT (jsonb_populate_record(stored_row, jsonb_build_object('tenant_id', $${peerParam}::text))).*
           FROM ${table} AS stored_row WHERE ${sql}`,
          [...values, peer.tenantId]
        )
      );
      await expect(copy).rejects.toMatchObject(rlsRejection);
    });
  });

  test("the peer probe sees the row once a permissive SELECT policy is added (rolled back)", async () => {
    // Proves that the zero above comes from the policy. A permissive policy ORs
    // with the tenant policy, and the catalog test stays green because the
    // tenant policy still names the GUC.
    const { peer } = await people();
    const key = await rowOf("project_folders");
    const client = await superuserPool().connect();
    let rollbackError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query("CREATE POLICY rls_write_paths_leak ON project_folders FOR SELECT USING (true)");
      // runRoleName() is generated by the harness, never input.
      await client.query(`SET LOCAL ROLE ${runRoleName()}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [peer.tenantId]);
      expect(await countRows(client, "project_folders", key)).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch((error: Error) => {
        rollbackError = error;
      });
      client.release(rollbackError);
    }
  });
});
