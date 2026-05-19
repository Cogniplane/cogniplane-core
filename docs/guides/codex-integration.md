# Codex Integration Guide

> **Scope:** Codex-specific integration details — protocol, transport, workspace generation, `codex.toml`, and Codex-specific security posture. For the equivalent Claude Code integration concerns, see the code in `apps/backend/src/services/claude-code-runtime-adapter.ts` and `claude-workspace-renderer.ts`. For the higher-level runtime selection model, see `runtime-selection.md`.

## Integration Approach

For Codex, Cogniplane uses **`codex app-server` only**.

It is the runtime protocol used for:
- granular streaming events
- thread lifecycle and resume
- per-turn sandbox policy
- approval-oriented flows
- MCP server configuration
- token usage capture from `turn/completed`

`codex-sdk` is intentionally out of scope.

The platform also supports a second runtime (Claude Code) via a separate adapter — nothing in this document applies to the Claude path.

## Recommendation

Use `codex app-server`, but choose the transport based on the runtime host:

- local runtime process: WebSocket on loopback
- E2B runtime process: stdio

Reasons:
- Local child processes are easiest to manage over loopback WebSocket from the backend.
- E2B already provides first-class stdin/stdout process control, so stdio avoids an extra bridge layer.
- Codex app-server documents stdio as the default transport and WebSocket as experimental.
- The framework should prefer the simplest transport available for each runtime host instead of forcing one transport everywhere.

Important framing:

- The framework is using Codex for its runtime harness, not because every product built on it is a coding agent.
- Planning, retries, approvals, and tool orchestration are broadly useful across enterprise assistants.
- Shell, git, file editing, and other high-agency powers are runtime-policy decisions, not default behavior.

Important caveat:

- Codex app-server WebSocket is still experimental in current Codex docs.
- That is acceptable for local loopback runtime communication, but it should not be forced onto remote sandbox integrations when stdio is available.
- The framework must not invent its own protocol contract.

## Protocol Authority

The framework should treat the Codex protocol as a versioned dependency, not as prose.

Rules:
- Pin a Codex version per deployment.
- Generate TypeScript schema artifacts with:

```bash
codex app-server generate-ts --out ./schemas
```

- Generate JSON schema artifacts with:

```bash
codex app-server generate-json-schema --out ./schemas
```

- Commit or package the generated artifacts alongside the framework code for that pinned version.
- Use the generated artifacts as the source of truth for client typing, event parsing, and upgrade review.
- Treat this markdown file as explanatory only.

Upgrade rule:

1. Bump the pinned Codex version.
2. Regenerate schemas.
3. Run protocol regression tests.
4. Review any changed methods, fields, or notifications before release.

## Runtime Credential Model

The framework uses a single shared enterprise OpenAI API key for Codex runtimes.

Rules:
- Store the key in a secret manager and inject it only into backend-controlled runtime hosts.
- Do not expose the key to the browser or to enterprise-published MCP servers.
- Attribute token usage from `turn/completed` events back to framework `userId`, `sessionId`, and department metadata in Postgres.
- Enforce spending visibility and quota policy in the backend framework, not in Codex.

## Session Runtime Model

The baseline framework model is **one `codex app-server` process per active session**.

This is a deliberate choice.

Why:
- simpler lifecycle
- clearer isolation boundary
- fewer stale-state bugs
- easier audit and crash recovery

Not in baseline:
- shared reusable worker pool
- prewarmed neutral runtimes

Those can be added later if cold starts become a measured problem.

## Transport and Handshake

Each session runtime exposes one app-server transport endpoint to the backend:

- local runtime: loopback WebSocket
- E2B runtime: stdio over the E2B command channel

The backend must follow the same official app-server initialization flow regardless of transport:

1. Open the transport connection.
2. Send `initialize` with client metadata and any required capabilities.
3. Send `initialized`.
4. Only then start or resume threads.

Important notes from the official docs:
- stdio is the documented default app-server transport.
- WebSocket transport uses bounded queues and remains experimental.
- When ingress is full, app-server can reject new requests with JSON-RPC error code `-32001` and message `Server overloaded; retry later.`
- The backend should use exponential backoff with jitter for retries where appropriate.

## App-Server Primitives the Framework Depends On

The framework should build around these official primitives:

- `initialize`
- `initialized`
- `thread/start`
- `thread/resume`
- `thread/read`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/status/changed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `turn/completed`

The framework may also use:
- `mcpServerStatus/list`
- `config/mcpServer/reload`
- `skills/list`
- `command/exec` only for explicitly approved or policy-enabled capabilities

Approval and review support must follow the official notification and request shapes for the pinned version. Do not hand-maintain speculative event names.

## Integration Rules

1. **Never expose raw app-server events to the frontend.** First translate them into framework `RuntimeEvent`s, then into Responses-style product/UI events.
2. **Never use Codex rollout JSONL as the product source of truth.** Postgres owns user-visible history.
3. **Never hand-maintain protocol event names as if they were stable.** Use generated schemas.
4. **Always record runtime metadata per session.** Store Codex version, generated schema version, runtime config version, and manifest hash.
5. **Always run with an explicit sandbox policy derived from the resolved runtime policy.**
6. **Treat Codex WebSocket as the native runtime truth.** Do not contort the runtime layer just to fake another provider's event model.
7. **Prefer OpenAI Responses API / OpenResponses event naming for frontend streaming.** Use `response.*` events for standard output/tool streaming.
8. **Use implementor-prefixed extension events for non-standard concepts.** For example, prefer `framework:approval_required` over ad hoc custom names.
9. **Only synthesize standard events when the semantics are clear.** If a Codex signal does not map cleanly, expose an extension event rather than a misleading `response.*` event.

## Session Runtime Configuration

Suggested framework config shape:

```typescript
type SessionRuntimeConfig = {
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  startTimeoutMs: number;
  turnTimeoutMs: number;
  codexBinaryPath: string;
  sandboxBasePath: string;
  sandboxMode: "external";
  codexVersion: string;
  codexSchemaVersion: string;
};
```

Recommended defaults:
- `idleTimeoutMs`: 15 minutes
- `startTimeoutMs`: 30 seconds
- `turnTimeoutMs`: 5 minutes
- `sandboxMode`: `external`

## Session Assignment Flow

1. `POST /messages` arrives for session `s-123`.
2. Session runtime manager checks whether `s-123` already has an active runtime process in `runtime_sessions`.
3. If yes:
   - reconnect or reuse that runtime
   - send `turn/start` on the existing thread
4. If no:
   - ensure the system is below `maxConcurrentSessions`
   - generate the session workspace
   - write `codex.toml`, skill files, and runtime manifest
   - start `codex app-server`
   - complete `initialize` / `initialized`
   - call `thread/start`
   - record the runtime in `runtime_sessions`

If capacity is exhausted:
- queue the request, or
- return a framework error such as `runtime_capacity_exceeded`

## Runtime Health Checks

The runtime manager should:

1. Track WebSocket connectivity and child-process exit state.
2. Use lightweight liveness checks where supported by the pinned version.
3. Mark the runtime unhealthy if the connection closes unexpectedly or health checks fail repeatedly.
4. Persist health state changes to `audit_events`.

## Crash Recovery

When a Codex session runtime exits unexpectedly:

1. Mark the runtime as `terminated` in `runtime_sessions`.
2. Fail the active turn with a structured error to the frontend.
3. Keep Postgres message history as the source of truth.
4. On the next user turn, start a fresh runtime and resume or reconstruct the thread as needed.

## Graceful Shutdown

During deployment or scale-down:

1. Stop accepting new runtime allocations.
2. Let active turns finish up to `turnTimeoutMs`.
3. Interrupt turns that exceed the timeout.
4. Terminate runtimes cleanly.
5. Update `runtime_sessions` status to `terminated`.

## Workspace Generation

When a runtime is created for a session, the framework generates:

```text
/sandboxes/{userId}/{sessionId}/
  codex.toml                       # Generated from MCP config + capability policy
  .codex/
    skills/
      content-generation.md
      sql-query.md
      info-retrieval.md
      document-analysis.md
  .framework/
    runtime-manifest.json          # Versions, hashes, runtime policy, Codex schema version
  uploads/                         # Symlinks or copies of user's uploaded docs
```

The runtime manifest should record at least:
- `codexVersion`
- `codexSchemaVersion`
- skill ids + versions + hashes
- MCP server ids + versions + hashes
- runtime policy version + hash
- session id
- user id

## `codex.toml` Generation

The `codex.toml` is generated dynamically from versioned admin config and the resolved runtime policy.

Illustrative example:

```toml
# Auto-generated for session {sessionId}
# Do not edit manually

[mcp]
[mcp.ax360-sql]
url = "http://localhost:8080/mcp/sql"
description = "Query client and account data via BigQuery"

[mcp.ax360-retrieval]
url = "http://localhost:8080/mcp/retrieval"
description = "Search enterprise knowledge base"

[mcp.ax360-documents]
url = "http://localhost:8080/mcp/documents"
description = "Analyze uploaded documents"
```

The exact config surface must match the pinned Codex version.

## Skill Generation and Versioning

Each enabled skill becomes a generated file in `.codex/skills/`.

The framework should version and hash every skill change.

A generated skill file may include metadata in a comment header such as:

```markdown
<!-- skill_id: sql-query | version: 12 | hash: abc123 -->
# SQL Query

{content}
```

The comment format is framework-defined. The important part is that the runtime manifest captures the same metadata for audit and replay.

## Runtime Policy Compilation

The framework should compile the resolved runtime policy into runtime behavior.

Policy controls include:
- sandbox mode
- writable roots
- additional readable roots
- network egress class
- tool allowlist
- approval policy
- whether shell/file/git actions are enabled
- whether user token forwarding is allowed

## Token Handling for MCP

The framework should support two paths:

### 1. First-party managed tools

For framework-owned or product-owned tools:
- runtime sends `toolContextId`
- gateway resolves trusted context
- managed tool broker injects service/user headers as needed
- broker owns downstream service interaction

### 2. Enterprise-published MCP servers

For trusted MCP servers published by other internal teams:
- runtime sends `toolContextId`
- gateway validates session ownership and token provenance
- gateway forwards the validated user token/context envelope to the trusted MCP server
- the target MCP server owns its own downstream authorization and service security

Design rule:

The framework should treat the user token as an **opaque credential envelope**. It validates provenance and forwarding eligibility, but it does not need to understand the downstream business semantics of every enterprise MCP server.

## Container Configuration

When running in Docker or Kubernetes:

```dockerfile
FROM node:22-slim

RUN npm install -g @openai/codex-cli

ENV CODEX_SANDBOX_MODE=external

WORKDIR /app
COPY entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
```

The entrypoint starts `codex app-server` with:
- `--sandbox external` to disable nested sandboxing
- WebSocket transport on a configured port
- the shared OpenAI API key injected from a secret manager

The container itself provides the security boundary:
- non-root user
- read-only root filesystem where possible
- writable mounted workspace only
- dropped capabilities
- network policy restricting egress to the OpenAI API and the backend MCP gateway only

This `externalSandbox` mode is the default production assumption for the framework.
