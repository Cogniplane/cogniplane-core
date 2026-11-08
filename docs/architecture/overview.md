# Architecture overview

Scope: system shape, code map, turn flow and shared terms. Read the subsystem
document for the code that you change; the [documentation
map](../../CLAUDE.md#documentation-map) lists them by task. Security invariants
that apply to all subsystems are in [security](../security.md).

## System

- The browser uses the Next.js frontend (`apps/frontend`). The frontend calls
  the Fastify backend (`apps/backend`). A chat turn streams AG-UI events over
  SSE.
- The backend runs the agent loop in its own process: LangChain
  [deepagentsjs](https://reference.langchain.com/javascript/deepagents) on
  LangGraph.
- Shell commands and workspace file tools run in a per-session E2B sandbox,
  created at first use, when the tenant allows command execution. Details:
  [sandbox](sandbox.md).
- Every MCP tool call goes through the backend's own MCP gateway
  (`/mcp/:serverId`). The gateway injects credentials and applies policy. The
  model never receives a credential.
- PostgreSQL stores all durable state except stored files, including LangGraph
  checkpoints (schema `deep_agents`). Row-level security (RLS) isolates tenants.
- With `REDIS_URL` (required with `jwt`), Redis holds short-lived shared state:
  sign-in, limits, turn replay ([contents](data.md#redis)).
- Object storage (local disk, or an S3-compatible bucket) holds artifacts and
  skill bundles.
- Authentication modes: `jwt` with WorkOS and/or local accounts, and
  `dev-headers` for local development only
  ([auth](auth.md#modes-and-sign-in-types)).

## Code map

| Path | Contents |
|---|---|
| `apps/backend/src/config.ts` | Environment schema and startup validation |
| `apps/backend/src/app.ts`, `app-dependencies.ts`, `app-bootstrap.ts` | Composition root: builds stores and services, registers routes |
| `apps/backend/src/runtime-contracts.ts`, `overlay-contracts.ts` | Runtime adapter and overlay contracts |
| `apps/backend/src/domain/` | Model catalog (`domain/models.ts`), runtime manifest |
| `apps/backend/src/routes/` | HTTP entry points; `routes/admin/` is the admin API; `routes/mcp.ts` is the MCP gateway |
| `apps/backend/src/services/deep-agents/` | Agent runtime: adapter, graph, E2B backend, checkpointer, AG-UI mapping, middleware |
| `apps/backend/src/services/runtime/` | Runtime lifecycle: model resolver, provider keys, sandbox network policy, approvals, idle teardown, sweepers |
| `apps/backend/src/services/mcp/`, `managed-tools/`, `policy/` | Gateway helpers, first-party tools, Policy Center |
| `apps/backend/src/services/auth/`, `lib/auth*.ts`, `lib/jwt.ts` | Authentication, step-up, tool execution contexts |
| `apps/backend/src/services/integrations/`, `connectors/` | GitHub, Notion, Jira (Pipedream) connectors |
| `apps/backend/src/services/skills/`, `artifacts/`, `pii/`, `mail/` | Skills, files, PII scans, email outbox |
| `apps/backend/src/services/*-store.ts` | Tenant-scoped persistence |
| `apps/backend/src/lib/db.ts` | Database pools and `withTenantScope` |
| `apps/backend/src/scripts/` | Migrations, `auth:bootstrap`, `auth:recover-owner`, `tenant:delete`, dev seed data |
| `apps/backend/src/integration/` | Tests against real PostgreSQL and Redis |
| `apps/backend/db/migrations/` | Authoritative SQL schema |
| `apps/frontend/src/app/` | Routes ([frontend](frontend.md#routes-srcapp)) |
| `apps/frontend/src/components/`, `hooks/`, `lib/` | UI, state, API clients; `lib/agui/` holds the browser agent |
| `apps/frontend/src/middleware.ts` | Sign-in redirects |
| `apps/frontend/sandbox-worker/` | Cloudflare Worker that serves the MCP App sandbox page |
| `packages/shared-types/src/` | Shared Zod contracts ([development](../development.md#conventions)) |
| `private/sharepoint-overlay-*` | Bundled SharePoint overlay |
| `docker/` | Backend and frontend images; E2B template (`template.ts`, `build.ts`) |
| `scripts/` | Repository scripts: test runner, dev port check, configuration reference and route index generators, doc tests, license check, coverage merge, local smoke test |

## Turn flow

1. `POST /messages` (`routes/messages.ts`) authenticates the request, checks
   session access, rate limits, quotas and the chat PII policy, and resolves the
   model.
2. The route takes the session execution lease, hijacks the socket and calls
   `streamAssistantReplyAGUI` (`services/sse-stream-writer-agui.ts`). The writer
   creates the per-turn `ToolExecutionContext` and calls
   `DeepAgentsRuntimeAdapter.runMessageAGUI`.
3. The adapter reserves model spending when the tenant has a limit, then runs a
   LangGraph `streamEvents` v2 stream. `stream-events-to-agui.ts` maps it to
   AG-UI events, which go to the browser as SSE frames.
4. Shell and file tools run in their backend (sandbox or graph state). MCP tools
   call the gateway with the session runtime token and the turn's
   `toolContextId`.
5. A gated tool call pauses the graph (interrupt). The browser decides with
   `POST /approvals/:approvalId/decision`, and the graph resumes.
6. `TurnTranscript` saves the final assistant message and tool results.

## Terms

- Tenant: an organization in the UI.
- Workspace: in the UI, the chat page (`/`); in the sandbox, the session
  directory `/home/user/workspace/<sessionId>/` ("sandbox workspace").
- Manager: an owner or admin who acts on another member's account.
- Sign-in: the user action. "Login" appears in code names (`login_type`,
  `AUTH_LOGIN_TYPES`) and in terms taken from them (login type, local login).
- Session: a chat session, unless the text says sign-in session (a refresh token
  family). "Local session" and "WorkOS session" mean sign-in sessions.
- Connector: a source of tools for the agent: a built-in one (GitHub, Notion,
  Jira), an overlay one (Microsoft 365), or an MCP server that an admin adds.
  Integration: the tenant-level record that an admin enables for a built-in or
  overlay connector (Admin > Connections, `tenant_integrations`). Connection: a
  configured access to a connector; a personal connection uses one member's
  account or credential.
- Capabilities: the skills and MCP connectors available to an agent
  ([resolution](skills.md#capability-resolution)).
- Normal chat: a session outside a project. Project chat: a session in a
  project. Differences: [session types](runtime.md#session-types).
- Admin pages: labels and paths are in
  `apps/frontend/src/app/admin/admin-sections.ts`. Agent behavior
  (`/admin/capabilities`) holds the tenant settings; Connections holds MCP
  servers and integrations.
- Policy Center: the rule engine behind Policies ([Policy
  Center](policy-center.md)).
