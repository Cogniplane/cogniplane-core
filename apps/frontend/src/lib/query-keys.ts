export const queryKeys = {
  projects: {
    all: ["projects"] as const,
    list: () => [...queryKeys.projects.all, "list"] as const,
    library: (projectId: string) => ["projects", projectId, "library"] as const,
    instructionsStatus: (projectId: string) => ["projects", projectId, "instructions-status"] as const
  },
  admin: {
    all: ["admin"] as const,
    skills: () => [...queryKeys.admin.all, "skills"] as const,
    skillRevisions: (skillId: string) =>
      [...queryKeys.admin.all, "skills", skillId, "revisions"] as const,
    marketplace: () => [...queryKeys.admin.all, "marketplace"] as const,
    mcpServers: () => [...queryKeys.admin.all, "mcp-servers"] as const,
    managedTools: () => [...queryKeys.admin.all, "managed-tools"] as const,
    tenant: () => [...queryKeys.admin.all, "tenant"] as const,
    tenantSettings: () => [...queryKeys.admin.all, "tenant-settings"] as const,
    openRouterModels: () => [...queryKeys.admin.all, "openrouter-models"] as const,
    users: () => [...queryKeys.admin.all, "users"] as const,
    runtimeSessions: () => [...queryKeys.admin.all, "runtime", "sessions"] as const,
    runtimeConfig: () => [...queryKeys.admin.all, "runtime", "config"] as const,
    sessions: <T extends object>(params?: T) =>
      [...queryKeys.admin.all, "sessions", params ?? {}] as const,
    sessionDetail: (sessionId: string) =>
      [...queryKeys.admin.all, "sessions", "detail", sessionId] as const,
    integrations: () => [...queryKeys.admin.all, "integrations"] as const,
    piiMetrics: (params: { range: string; from?: string; to?: string }) =>
      [...queryKeys.admin.all, "pii", "metrics", params] as const,
    piiTop: (params: {
      range: string;
      from?: string;
      to?: string;
      groupBy: "user" | "session";
      limit?: number;
    }) => [...queryKeys.admin.all, "pii", "top", params] as const,
    piiRecent: (params: {
      range: string;
      from?: string;
      to?: string;
      actions?: string[];
      limit?: number;
    }) => [...queryKeys.admin.all, "pii", "recent", params] as const,
    piiJobsStats: (params: { range: string; from?: string; to?: string }) =>
      [...queryKeys.admin.all, "pii", "jobs/stats", params] as const,
    policyRules: () => [...queryKeys.admin.all, "policy", "rules"] as const,
    // Params are the serializable decisions filter+paging shape; passed verbatim
    // so two different filter sets get distinct cache entries.
    policyDecisions: <T extends object>(params?: T) =>
      [...queryKeys.admin.all, "policy", "decisions", params ?? {}] as const,
    policyDecision: (decisionId: string) =>
      [...queryKeys.admin.all, "policy", "decision", decisionId] as const,
    policyLint: () => [...queryKeys.admin.all, "policy", "lint"] as const,
    tokenUsage: (days: number) =>
      [...queryKeys.admin.all, "reports", "token-usage", { days }] as const,
    messageFeedback: (days: number) =>
      [...queryKeys.admin.all, "reports", "message-feedback", { days }] as const
  },
  settings: {
    all: ["settings"] as const,
    overview: () => [...queryKeys.settings.all, "overview"] as const,
    sections: () => [...queryKeys.settings.all, "sections"] as const,
    scheduledJobs: () => [...queryKeys.settings.all, "scheduled-jobs"] as const,
    scheduledJobRuns: (jobId: string) =>
      [...queryKeys.settings.all, "scheduled-jobs", jobId, "runs"] as const,
    github: () => [...queryKeys.settings.all, "github"] as const,
    microsoft: () => [...queryKeys.settings.all, "microsoft"] as const,
    notion: () => [...queryKeys.settings.all, "notion"] as const,
    tokenUsage: (days: number) =>
      [...queryKeys.settings.all, "reports", "token-usage", { days }] as const,
    integrationsAvailability: () =>
      [...queryKeys.settings.all, "integrations-availability"] as const
  },
  sessions: {
    all: ["sessions"] as const,
    archived: () => [...queryKeys.sessions.all, "archived"] as const,
    list: (scope?: string) =>
      scope ? ([...queryKeys.sessions.all, "list", scope] as const) : ([...queryKeys.sessions.all, "list"] as const),
    detail: (sessionId: string) => [...queryKeys.sessions.all, "detail", sessionId] as const,
    messages: (sessionId: string) =>
      [...queryKeys.sessions.all, "detail", sessionId, "messages"] as const,
    artifacts: (sessionId: string) =>
      [...queryKeys.sessions.all, "detail", sessionId, "artifacts"] as const,
    approvals: (sessionId: string) =>
      [...queryKeys.sessions.all, "detail", sessionId, "approvals"] as const
  },
  microsoft: {
    all: ["microsoft"] as const,
    connectionStatus: () => [...queryKeys.microsoft.all, "connection-status"] as const,
    sites: (search: string) => [...queryKeys.microsoft.all, "sites", search] as const,
    browse: (location: { siteId: string | null; driveId: string | null; folderId: string | null }) =>
      [...queryKeys.microsoft.all, "browse", location] as const,
    search: (query: string) => [...queryKeys.microsoft.all, "search", query] as const
  },
  // Everything derived from the tenant's model availability shares this prefix,
  // so one invalidateQueries({ queryKey: queryKeys.models.all }) refreshes the
  // chat catalog and the admin key-source view together.
  models: {
    all: ["models"] as const,
    list: () => [...queryKeys.models.all, "list"] as const,
    adminCatalog: () => [...queryKeys.models.all, "admin-catalog"] as const
  },
  artifacts: {
    all: ["artifacts"] as const,
    browse: <T extends object>(params?: T) =>
      [...queryKeys.artifacts.all, "browse", params ?? {}] as const
  }
} as const;
