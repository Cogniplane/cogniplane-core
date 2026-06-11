import type { Pool } from "../../lib/db.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { GithubConnectionService } from "../integrations/github/github-connection-service.js";
import type { NotionConnectionService } from "../integrations/notion/notion-connection-service.js";
import type { MessageStore } from "../message-store.js";
import type { PiiProtectionService } from "../pii/pii-protection-service.js";
import type { SessionStore } from "../session-store.js";
import type { ManagedToolDefinition } from "./types.js";

// Shared deps bag every managed-tool factory may consume. Each factory only
// reads the slots it needs. Integration-specific dependencies (e.g. the
// SharePoint factory's Microsoft Graph services) are NOT in this bag —
// integrations register their factories via closures that capture their own
// typed dependencies, so an integration can ship from a private overlay
// without leaking its type surface into core.
export type ManagedToolFactoryDeps = {
  db: Pool;
  dynamicConfig: DynamicConfigService;
  sessions: SessionStore;
  messages: MessageStore;
  artifacts: ArtifactStore;
  storage: ArtifactStorage;
  auditEvents: AuditEventStore;
  githubConnections: GithubConnectionService;
  notionConnections: NotionConnectionService;
  /** Optional — forwarded to tools that aggregate cross-session content. */
  piiProtection?: PiiProtectionService;
  readRuntimeFile?: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
  /** Optional — size probe so oversized files are rejected before buffering. */
  statRuntimeFile?: (
    sessionId: string,
    runtimeId: string,
    filePath: string
  ) => Promise<{ sizeBytes: number }>;
  writeRuntimeFile?: (
    sessionId: string,
    runtimeId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ) => Promise<string>;
};

export type ManagedToolFactory = (deps: ManagedToolFactoryDeps) => ManagedToolDefinition[];

export class ManagedToolFactoryRegistry {
  private readonly factories = new Map<string, ManagedToolFactory>();

  // `name` is a domain key (e.g. "session", "github", "sharepoint"), not a
  // tool name — one factory typically produces multiple tool definitions.
  // Throwing on duplicate keys mirrors ManagedToolCatalog.register so a
  // misconfigured overlay surfaces at boot rather than producing duplicate
  // tool definitions at runtime.
  register(name: string, factory: ManagedToolFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Managed tool factory already registered: ${name}`);
    }
    this.factories.set(name, factory);
  }

  createDefinitions(deps: ManagedToolFactoryDeps): ManagedToolDefinition[] {
    const out: ManagedToolDefinition[] = [];
    for (const factory of this.factories.values()) {
      out.push(...factory(deps));
    }
    return out;
  }
}
